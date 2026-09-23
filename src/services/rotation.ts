/**
 * Provider-agnostic rotation engine.
 *
 * A single key on a single model is a hard ceiling: the first 429 ends the
 * session. This module turns that ceiling into a pool. Every (route, key) pair
 * becomes an independently accounted slot, and a review walks the pool until
 * one slot answers. Capacity is therefore pool depth multiplied by key
 * multiplicity, and the only thing a user has to do to raise it is add another
 * route or another key.
 *
 * Nothing here imports `vscode`, so the whole engine runs under plain Node in
 * the unit tests. Persistence and clock are injected.
 */

/** A pause shorter than this is a hiccup; anything longer means the window is spent. */
export const EXHAUSTION_THRESHOLD_MS = 5 * 60_000;

/** Fallback pause for transport failures and 5xx, where the provider says nothing useful. */
export const DEFAULT_COOLDOWN_MS = 15_000;

/** Fallback pause for a 429 that arrives with no usable reset header. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Fallback pause for a spent window when the provider does not say when it refills. */
export const DEFAULT_EXHAUSTED_COOLDOWN_MS = 60 * 60_000;

/** A key the provider actively rejected is parked for the rest of the working day. */
export const KEY_REJECTED_COOLDOWN_MS = 6 * 60 * 60_000;

/** A model the provider does not serve will not appear before the catalog changes. */
export const ROUTE_REJECTED_COOLDOWN_MS = 60 * 60_000;

/** Upper bound on any provider-declared pause, so one bad header cannot park a slot forever. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * One addressable destination: a model on a base URL, ranked by tier.
 * Tier 1 is the best model the user has; higher numbers are the fallbacks the
 * pool degrades to when tier 1 runs dry.
 */
export interface RouteDefinition {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  tier: number;
}

/** A route paired with one specific credential. This is the unit that gets rate limited. */
export interface PoolSlot {
  id: string;
  order: number;
  route: RouteDefinition;
  apiKey: string;
  keyLabel: string;
}

/** A slot checked out for the duration of one request attempt. */
export interface Lease {
  slotId: string;
  route: RouteDefinition;
  apiKey: string;
  keyLabel: string;
}

/** Why a slot is unavailable. `live` and `in-flight` are both usable; the rest are paused. */
export type SlotState = 'live' | 'in-flight' | 'cooling' | 'exhausted' | 'key-rejected' | 'route-rejected';

/** The paused states, which are the only ones worth persisting across a window reload. */
export type PausedState = Exclude<SlotState, 'live' | 'in-flight'>;

export interface SlotRecord {
  state: PausedState;
  until: number;
  reason: string;
}

/**
 * How an attempt ended. The pool turns this into a pause, so the classification
 * done by the caller is the single place that decides recovery timing.
 */
export type AttemptOutcome =
  | { kind: 'ok' }
  | { kind: 'cooling'; retryAfterMs: number | null; reason: string }
  | { kind: 'exhausted'; retryAfterMs: number | null; reason: string }
  | { kind: 'key-rejected'; reason: string }
  | { kind: 'route-rejected'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'aborted' };

export interface LedgerStorage {
  read(): Record<string, SlotRecord> | undefined;
  write(records: Record<string, SlotRecord>): void;
}

export interface SlotSnapshot {
  slotId: string;
  routeLabel: string;
  model: string;
  provider: string;
  tier: number;
  keyLabel: string;
  state: SlotState;
  until: number | null;
  reason: string;
}

/**
 * Durable quota accounting.
 *
 * Only paused slots are stored. A live slot is the absence of a record, which
 * keeps the persisted blob proportional to the damage rather than to the pool
 * size, and means a pool the user reconfigures does not drag stale entries
 * along. Daily windows outlive a window reload, so the store has to be durable
 * rather than in-memory.
 */
export class QuotaLedger {
  private records: Record<string, SlotRecord>;
  private readonly inFlight = new Set<string>();
  private readonly lastUsed = new Map<string, number>();

  constructor(private readonly storage: LedgerStorage) {
    this.records = { ...(storage.read() ?? {}) };
  }

  statusOf(slotId: string, now: number): SlotState {
    const record = this.records[slotId];

    if (record !== undefined) {
      if (record.until > now) {
        return record.state;
      }
      this.clear(slotId);
    }

    return this.inFlight.has(slotId) ? 'in-flight' : 'live';
  }

  recordFor(slotId: string, now: number): SlotRecord | null {
    const record = this.records[slotId];
    return record !== undefined && record.until > now ? record : null;
  }

  pause(slotId: string, state: PausedState, durationMs: number, reason: string, now: number): void {
    const bounded = Math.min(Math.max(durationMs, 0), MAX_COOLDOWN_MS);
    const until = now + bounded;
    const existing = this.records[slotId];

    // A longer pause always wins: an hourly window does not reopen because a
    // later request happened to come back with a fifteen second hint.
    if (existing !== undefined && existing.until >= until) {
      return;
    }

    this.records[slotId] = { state, until, reason };
    this.persist();
  }

  clear(slotId: string): void {
    if (this.records[slotId] === undefined) {
      return;
    }

    delete this.records[slotId];
    this.persist();
  }

  markInFlight(slotId: string, now: number): void {
    this.inFlight.add(slotId);
    this.lastUsed.set(slotId, now);
  }

  releaseInFlight(slotId: string): void {
    this.inFlight.delete(slotId);
  }

  lastUsedAt(slotId: string): number {
    return this.lastUsed.get(slotId) ?? 0;
  }

  /** Drops every pause. Used by the "reset pool" command when a user fixes their billing. */
  reset(): void {
    this.records = {};
    this.inFlight.clear();
    this.persist();
  }

  private persist(): void {
    this.storage.write({ ...this.records });
  }
}

/**
 * Ordered view over the slots available to one review.
 *
 * Route exclusions live here rather than in the ledger because they are
 * request-specific: a prompt too long for an 8k model says nothing about that
 * model's quota, so it must not outlive the request that discovered it.
 */
export class RotationPool {
  private readonly excludedRoutes = new Set<string>();

  constructor(
    private readonly slots: readonly PoolSlot[],
    private readonly ledger: QuotaLedger
  ) {}

  get size(): number {
    return this.slots.length;
  }

  get routeCount(): number {
    return new Set(this.slots.map((slot) => slot.route.id)).size;
  }

  /**
   * Checks out the best usable slot.
   *
   * Tier dominates: quality is the reason the user ranked the routes, so the
   * pool exhausts a tier before degrading. Within a tier it prefers an idle
   * slot over one already serving another review, then the least recently used,
   * which is what spreads load evenly across keys.
   */
  acquire(now: number = Date.now()): Lease | null {
    let best: { slot: PoolSlot; busy: number } | null = null;

    for (const slot of this.slots) {
      if (this.excludedRoutes.has(slot.route.id)) {
        continue;
      }

      const state = this.ledger.statusOf(slot.id, now);
      if (state !== 'live' && state !== 'in-flight') {
        continue;
      }

      const candidate = { slot, busy: state === 'in-flight' ? 1 : 0 };
      if (best === null || this.isBetter(candidate, best)) {
        best = candidate;
      }
    }

    if (best === null) {
      return null;
    }

    this.ledger.markInFlight(best.slot.id, now);

    return {
      slotId: best.slot.id,
      route: best.slot.route,
      apiKey: best.slot.apiKey,
      keyLabel: best.slot.keyLabel,
    };
  }

  /** Returns the lease to the pool and applies whatever the outcome implies. */
  release(lease: Lease, outcome: AttemptOutcome, now: number = Date.now()): void {
    this.ledger.releaseInFlight(lease.slotId);

    switch (outcome.kind) {
      case 'ok':
        this.ledger.clear(lease.slotId);
        return;

      case 'aborted':
        return;

      case 'cooling':
        this.ledger.pause(
          lease.slotId,
          'cooling',
          outcome.retryAfterMs ?? DEFAULT_COOLDOWN_MS,
          outcome.reason,
          now
        );
        return;

      case 'exhausted':
        this.ledger.pause(
          lease.slotId,
          'exhausted',
          outcome.retryAfterMs ?? DEFAULT_EXHAUSTED_COOLDOWN_MS,
          outcome.reason,
          now
        );
        return;

      case 'key-rejected':
        // The provider rejected the credential itself, so every route reachable
        // with that same key is dead too, not just the one that noticed.
        for (const slot of this.slotsSharingKey(lease)) {
          this.ledger.pause(slot.id, 'key-rejected', KEY_REJECTED_COOLDOWN_MS, outcome.reason, now);
        }
        return;

      case 'route-rejected':
        for (const slot of this.slotsOnRoute(lease.route.id)) {
          this.ledger.pause(slot.id, 'route-rejected', ROUTE_REJECTED_COOLDOWN_MS, outcome.reason, now);
        }
        return;

      case 'skip':
        this.excludedRoutes.add(lease.route.id);
        return;
    }
  }

  /** Earliest moment any paused slot becomes usable again, or null if none will. */
  nextRecoveryAt(now: number = Date.now()): number | null {
    let earliest: number | null = null;

    for (const slot of this.slots) {
      if (this.excludedRoutes.has(slot.route.id)) {
        continue;
      }

      const record = this.ledger.recordFor(slot.id, now);
      if (record === null) {
        continue;
      }

      if (earliest === null || record.until < earliest) {
        earliest = record.until;
      }
    }

    return earliest;
  }

  /** Full pool state, for the status command and the output log. */
  describe(now: number = Date.now()): SlotSnapshot[] {
    return this.slots.map((slot) => {
      const record = this.ledger.recordFor(slot.id, now);
      const excluded = this.excludedRoutes.has(slot.route.id);

      return {
        slotId: slot.id,
        routeLabel: slot.route.label,
        model: slot.route.model,
        provider: slot.route.provider,
        tier: slot.route.tier,
        keyLabel: slot.keyLabel,
        state: record?.state ?? this.ledger.statusOf(slot.id, now),
        until: record?.until ?? null,
        reason: excluded ? 'Skipped for this request.' : (record?.reason ?? ''),
      };
    });
  }

  private isBetter(
    candidate: { slot: PoolSlot; busy: number },
    incumbent: { slot: PoolSlot; busy: number }
  ): boolean {
    if (candidate.slot.route.tier !== incumbent.slot.route.tier) {
      return candidate.slot.route.tier < incumbent.slot.route.tier;
    }

    if (candidate.busy !== incumbent.busy) {
      return candidate.busy < incumbent.busy;
    }

    const candidateLastUsed = this.ledger.lastUsedAt(candidate.slot.id);
    const incumbentLastUsed = this.ledger.lastUsedAt(incumbent.slot.id);
    if (candidateLastUsed !== incumbentLastUsed) {
      return candidateLastUsed < incumbentLastUsed;
    }

    return candidate.slot.order < incumbent.slot.order;
  }

  private slotsSharingKey(lease: Lease): PoolSlot[] {
    return this.slots.filter(
      (slot) => slot.apiKey === lease.apiKey && slot.route.provider === lease.route.provider
    );
  }

  private slotsOnRoute(routeId: string): PoolSlot[] {
    return this.slots.filter((slot) => slot.route.id === routeId);
  }
}

/**
 * Expands routes against the credentials available for each one.
 *
 * A route whose provider has no key is dropped rather than carried as a slot
 * that is guaranteed to fail: the user gets one clear "no credentials" error
 * instead of watching the pool burn attempts on it. The lookup is per route,
 * not per provider, so a caller can grant an unauthenticated slot to a local
 * gateway while still demanding a key for the same preset pointed at the
 * internet.
 */
export function buildPool(
  routes: readonly RouteDefinition[],
  keysForRoute: (route: RouteDefinition) => readonly string[],
  ledger: QuotaLedger
): RotationPool {
  const slots: PoolSlot[] = [];

  for (const route of routes) {
    for (const apiKey of keysForRoute(route)) {
      slots.push({
        id: `${route.id}::${fingerprintKey(apiKey)}`,
        order: slots.length,
        route,
        apiKey,
        keyLabel: maskKey(apiKey),
      });
    }
  }

  return new RotationPool(slots, ledger);
}

/** Stable identity for a destination, so ledger entries survive a settings edit elsewhere. */
export function makeRouteId(provider: string, baseUrl: string, model: string): string {
  return `${provider}|${baseUrl}|${model}`;
}

/**
 * Non-cryptographic FNV-1a digest. It only has to be stable and non-reversible
 * enough that a persisted ledger never contains the key itself.
 */
export function fingerprintKey(apiKey: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < apiKey.length; index += 1) {
    hash ^= apiKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Human-readable key identity for logs and the status view. Never the whole key. */
export function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();

  if (trimmed.length === 0) {
    return 'keyless';
  }

  if (trimmed.length <= 8) {
    return `key-${fingerprintKey(trimmed).slice(0, 4)}`;
  }

  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export type HeaderLookup = (name: string) => string | null | undefined;

/**
 * Headers providers use to say when capacity returns, most specific first.
 * `retry-after` is the standard one; the rest are the de facto variants shipped
 * by OpenAI, OpenRouter, Anthropic and the gateways that proxy them.
 */
const RESET_HEADERS = [
  'retry-after',
  'x-ratelimit-reset-after',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset',
  'ratelimit-reset',
];

/**
 * Reads the provider's own recovery hint.
 *
 * Every accepted form is a different vendor's idea of the same fact: delta
 * seconds, an epoch stamp in seconds or milliseconds, an HTTP date, or a
 * duration like `1m30s`. Guessing wrong in the pessimistic direction only costs
 * a rotation, so unparseable values return null and the caller falls back.
 */
export function parseRetryAfterMs(lookup: HeaderLookup, now: number = Date.now()): number | null {
  for (const header of RESET_HEADERS) {
    const raw = lookup(header);
    if (raw === null || raw === undefined) {
      continue;
    }

    const parsed = interpretResetValue(raw.trim(), now);
    if (parsed !== null && parsed > 0) {
      return Math.min(parsed, MAX_COOLDOWN_MS);
    }
  }

  return null;
}

function interpretResetValue(value: string, now: number): number | null {
  if (value.length === 0) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(value)) {
    const numeric = Number(value);

    // Disambiguated by magnitude: past ~1e12 it can only be epoch milliseconds,
    // past ~1e9 only epoch seconds, and anything smaller is a delta.
    if (numeric >= 1e12) {
      return numeric - now;
    }
    if (numeric >= 1e9) {
      return numeric * 1000 - now;
    }
    return numeric * 1000;
  }

  const duration = parseDurationMs(value);
  if (duration !== null) {
    return duration;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp - now;
}

const DURATION_PATTERN = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseDurationMs(value: string): number | null {
  const normalized = value.toLowerCase();
  let total = 0;
  let matched = false;
  let consumed = 0;

  DURATION_PATTERN.lastIndex = 0;
  for (let match = DURATION_PATTERN.exec(normalized); match !== null; match = DURATION_PATTERN.exec(normalized)) {
    total += Number(match[1]) * DURATION_UNIT_MS[match[2]];
    consumed += match[0].length;
    matched = true;
  }

  // Guards against a stray unit inside prose: only a string that is entirely
  // duration tokens is a duration.
  return matched && consumed === normalized.length ? total : null;
}

/** A pause long enough to mean the window is spent rather than merely throttled. */
export function classifyPause(retryAfterMs: number | null): 'cooling' | 'exhausted' {
  return retryAfterMs !== null && retryAfterMs > EXHAUSTION_THRESHOLD_MS ? 'exhausted' : 'cooling';
}

/** Compact "4m 12s" phrasing for user-facing waits. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
