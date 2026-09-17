import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HeaderLookup,
  MAX_COOLDOWN_MS,
  QuotaLedger,
  RouteDefinition,
  SlotRecord,
  buildPool,
  classifyPause,
  fingerprintKey,
  formatDuration,
  makeRouteId,
  maskKey,
  parseRetryAfterMs,
} from './rotation';

function memoryStorage() {
  const state: { value: Record<string, SlotRecord> | undefined } = { value: undefined };

  return {
    state,
    read: () => state.value,
    write: (records: Record<string, SlotRecord>) => {
      state.value = records;
    },
  };
}

function route(model: string, tier: number, provider = 'openrouter'): RouteDefinition {
  const baseUrl = `https://${provider}.test/v1`;

  return {
    id: makeRouteId(provider, baseUrl, model),
    label: `${model} (${provider})`,
    provider,
    baseUrl,
    model,
    tier,
  };
}

function headers(map: Record<string, string>): HeaderLookup {
  return (name) => map[name] ?? null;
}

function poolOf(routes: RouteDefinition[], keys: string[], ledger: QuotaLedger) {
  return buildPool(routes, () => keys, ledger);
}

// ── Selection order ──────────────────────────────────────────────────────────

test('acquires the lowest tier first', () => {
  const pool = poolOf([route('fast', 2), route('best', 1)], ['k1'], new QuotaLedger(memoryStorage()));

  assert.equal(pool.acquire(1_000)?.route.model, 'best');
});

test('round-robins across the keys of one route', () => {
  const pool = poolOf([route('m', 1)], ['k1', 'k2'], new QuotaLedger(memoryStorage()));

  const first = pool.acquire(1_000);
  assert.ok(first !== null);
  pool.release(first, { kind: 'ok' }, 1_000);

  const second = pool.acquire(2_000);
  assert.notEqual(second?.apiKey, first.apiKey);

  pool.release(second!, { kind: 'ok' }, 2_000);
  assert.equal(pool.acquire(3_000)?.apiKey, first.apiKey);
});

test('prefers an idle slot over one already serving another review', () => {
  const pool = poolOf([route('m', 1)], ['k1', 'k2'], new QuotaLedger(memoryStorage()));

  const first = pool.acquire(1_000);
  const second = pool.acquire(1_001);

  assert.notEqual(second?.apiKey, first?.apiKey);
});

test('falls back to a busy slot rather than reporting no capacity', () => {
  const pool = poolOf([route('m', 1)], ['k1'], new QuotaLedger(memoryStorage()));

  assert.ok(pool.acquire(1_000) !== null);
  assert.ok(pool.acquire(1_001) !== null);
});

test('tier outranks idleness, so quality is never traded for parallelism', () => {
  const pool = poolOf(
    [route('best', 1), route('cheap', 2)],
    ['k1'],
    new QuotaLedger(memoryStorage())
  );

  assert.equal(pool.acquire(1_000)?.route.model, 'best');
  assert.equal(pool.acquire(1_001)?.route.model, 'best');
});

// ── Outcome handling ─────────────────────────────────────────────────────────

test('a rate limited slot is skipped until the provider said it recovers', () => {
  const pool = poolOf([route('m', 1)], ['k1', 'k2'], new QuotaLedger(memoryStorage()));

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'cooling', retryAfterMs: 30_000, reason: 'Throttled.' }, 0);

  assert.notEqual(pool.acquire(1_000)?.apiKey, lease!.apiKey);
  assert.equal(pool.acquire(31_000)?.apiKey, lease!.apiKey);
});

test('a rejected key is parked on every route that shares it', () => {
  const ledger = new QuotaLedger(memoryStorage());
  const pool = buildPool([route('a', 1), route('b', 2)], () => ['k1', 'k2'], ledger);

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'key-rejected', reason: 'Rejected with 401.' }, 0);

  const usable = pool.describe(1_000).filter((slot) => slot.state === 'live');
  assert.equal(usable.length, 2);
  assert.ok(usable.every((slot) => slot.keyLabel !== lease!.keyLabel));
});

test('a rejected model parks every key on that route only', () => {
  const ledger = new QuotaLedger(memoryStorage());
  const pool = buildPool([route('a', 1), route('b', 2)], () => ['k1', 'k2'], ledger);

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'route-rejected', reason: 'Model not found.' }, 0);

  const usable = pool.describe(1_000).filter((slot) => slot.state === 'live');
  assert.equal(usable.length, 2);
  assert.ok(usable.every((slot) => slot.model === 'b'));
});

test('a prompt that does not fit skips the route without charging its quota', () => {
  const storage = memoryStorage();
  const ledger = new QuotaLedger(storage);
  const pool = buildPool([route('small', 1), route('large', 2)], () => ['k1'], ledger);

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'skip', reason: 'Too long.' }, 0);

  assert.equal(pool.acquire(1)?.route.model, 'large');
  assert.deepEqual(storage.state.value, undefined);
});

test('a success clears an earlier pause on that slot', () => {
  const pool = poolOf([route('m', 1)], ['k1'], new QuotaLedger(memoryStorage()));

  const first = pool.acquire(0);
  pool.release(first!, { kind: 'cooling', retryAfterMs: 30_000, reason: 'Throttled.' }, 0);
  assert.equal(pool.acquire(1_000), null);

  const later = pool.acquire(31_000);
  pool.release(later!, { kind: 'ok' }, 31_000);
  assert.ok(pool.acquire(31_001) !== null);
});

test('an aborted attempt leaves the slot untouched', () => {
  const pool = poolOf([route('m', 1)], ['k1'], new QuotaLedger(memoryStorage()));

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'aborted' }, 0);

  assert.equal(pool.describe(1)[0].state, 'live');
});

test('reports when the pool is empty and when the first slot returns', () => {
  const pool = poolOf([route('m', 1)], ['k1'], new QuotaLedger(memoryStorage()));

  const lease = pool.acquire(0);
  pool.release(lease!, { kind: 'exhausted', retryAfterMs: 3_600_000, reason: 'Spent.' }, 0);

  assert.equal(pool.acquire(1_000), null);
  assert.equal(pool.nextRecoveryAt(1_000), 3_600_000);
});

test('nextRecoveryAt picks the soonest of several pauses', () => {
  const ledger = new QuotaLedger(memoryStorage());
  const pool = buildPool([route('a', 1), route('b', 2)], () => ['k1'], ledger);

  const first = pool.acquire(0);
  pool.release(first!, { kind: 'exhausted', retryAfterMs: 3_600_000, reason: 'Spent.' }, 0);

  const second = pool.acquire(0);
  pool.release(second!, { kind: 'cooling', retryAfterMs: 20_000, reason: 'Throttled.' }, 0);

  assert.equal(pool.nextRecoveryAt(0), 20_000);
});

// ── Pool construction ────────────────────────────────────────────────────────

test('expands every route against every key', () => {
  const pool = buildPool([route('a', 1), route('b', 2)], () => ['k1', 'k2'], new QuotaLedger(memoryStorage()));

  assert.equal(pool.size, 4);
  assert.equal(pool.routeCount, 2);
});

test('drops a route that has no credentials', () => {
  const pool = buildPool(
    [route('a', 1), route('b', 2, 'ollama')],
    (candidate) => (candidate.provider === 'ollama' ? [] : ['k1']),
    new QuotaLedger(memoryStorage())
  );

  assert.equal(pool.size, 1);
  assert.equal(pool.describe(0)[0].model, 'a');
});

// ── Ledger ───────────────────────────────────────────────────────────────────

test('a pause expires on its own clock', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.pause('slot', 'cooling', 1_000, 'Throttled.', 0);

  assert.equal(ledger.statusOf('slot', 500), 'cooling');
  assert.equal(ledger.statusOf('slot', 1_500), 'live');
});

test('a longer pause is never shortened by a later hint', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.pause('slot', 'exhausted', 3_600_000, 'Spent.', 0);
  ledger.pause('slot', 'cooling', 15_000, 'Throttled.', 0);

  assert.equal(ledger.statusOf('slot', 60_000), 'exhausted');
});

test('a longer pause replaces a shorter one', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.pause('slot', 'cooling', 15_000, 'Throttled.', 0);
  ledger.pause('slot', 'exhausted', 3_600_000, 'Spent.', 0);

  assert.equal(ledger.statusOf('slot', 60_000), 'exhausted');
});

test('clamps a pause that would park a slot past the ceiling', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.pause('slot', 'exhausted', 30 * 86_400_000, 'Absurd header.', 0);

  assert.equal(ledger.recordFor('slot', 0)?.until, MAX_COOLDOWN_MS);
});

test('pauses survive a reload through the backing store', () => {
  const storage = memoryStorage();
  new QuotaLedger(storage).pause('slot', 'exhausted', 3_600_000, 'Spent.', 0);

  assert.equal(new QuotaLedger(storage).statusOf('slot', 1_000), 'exhausted');
});

test('an expired pause is dropped from the store rather than accumulating', () => {
  const storage = memoryStorage();
  const ledger = new QuotaLedger(storage);

  ledger.pause('slot', 'cooling', 1_000, 'Throttled.', 0);
  ledger.statusOf('slot', 2_000);

  assert.deepEqual(storage.state.value, {});
});

test('reset marks everything live again', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.pause('slot', 'exhausted', 3_600_000, 'Spent.', 0);
  ledger.reset();

  assert.equal(ledger.statusOf('slot', 0), 'live');
});

test('an in-flight slot reports as in-flight until it is released', () => {
  const ledger = new QuotaLedger(memoryStorage());

  ledger.markInFlight('slot', 0);
  assert.equal(ledger.statusOf('slot', 0), 'in-flight');

  ledger.releaseInFlight('slot');
  assert.equal(ledger.statusOf('slot', 0), 'live');
});

// ── Recovery hints ───────────────────────────────────────────────────────────

test('reads Retry-After as a delta in seconds', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '30' }), 0), 30_000);
});

test('reads an epoch reset in seconds', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs(headers({ 'x-ratelimit-reset': '1700000060' }), now), 60_000);
});

test('reads an epoch reset in milliseconds', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs(headers({ 'x-ratelimit-reset': '1700000060000' }), now), 60_000);
});

test('reads a compound duration', () => {
  assert.equal(parseRetryAfterMs(headers({ 'x-ratelimit-reset-requests': '1m30s' }), 0), 90_000);
});

test('reads a millisecond duration without mistaking it for seconds', () => {
  assert.equal(parseRetryAfterMs(headers({ 'x-ratelimit-reset-tokens': '6ms' }), 0), 6);
});

test('reads an HTTP date', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetAt = new Date(now + 5_000).toUTCString();

  assert.equal(parseRetryAfterMs(headers({ 'retry-after': resetAt }), now), 5_000);
});

test('prefers Retry-After over the vendor reset headers', () => {
  const lookup = headers({ 'retry-after': '10', 'x-ratelimit-reset': '999' });

  assert.equal(parseRetryAfterMs(lookup, 0), 10_000);
});

test('ignores a hint that already elapsed', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '0' }), 0), null);
});

test('ignores prose that merely contains a unit letter', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': 'try again in a moment' }), 0), null);
});

test('ignores a header that is absent', () => {
  assert.equal(parseRetryAfterMs(headers({}), 0), null);
});

test('clamps an absurd hint to the ceiling', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '9999999999' }), 0), MAX_COOLDOWN_MS);
});

test('separates a throttle from a spent window by how long it lasts', () => {
  assert.equal(classifyPause(null), 'cooling');
  assert.equal(classifyPause(60_000), 'cooling');
  assert.equal(classifyPause(6 * 60_000), 'exhausted');
});

// ── Formatting and identity ──────────────────────────────────────────────────

test('formats waits the way a person would say them', () => {
  assert.equal(formatDuration(500), '1s');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(5_400_000), '1h 30m');
});

test('fingerprints a key stably without revealing it', () => {
  const digest = fingerprintKey('sk-or-v1-secret');

  assert.equal(digest, fingerprintKey('sk-or-v1-secret'));
  assert.notEqual(digest, fingerprintKey('sk-or-v1-secreu'));
  assert.match(digest, /^[0-9a-f]{8}$/);
});

test('masks keys down to something safe to print', () => {
  assert.equal(maskKey(''), 'keyless');
  assert.equal(maskKey('sk-or-v1-abcd1234'), 'sk-...1234');
  assert.match(maskKey('short'), /^key-[0-9a-f]{4}$/);
});

test('route identity ignores nothing that would change where a request lands', () => {
  assert.equal(
    makeRouteId('openrouter', 'https://a/v1', 'm'),
    makeRouteId('openrouter', 'https://a/v1', 'm')
  );
  assert.notEqual(
    makeRouteId('openrouter', 'https://a/v1', 'm'),
    makeRouteId('openrouter', 'https://b/v1', 'm')
  );
});
