# CodeSage AI — Roadmap

**Status:** planning. No implementation has started; this document is the agreed plan of record.

---

## Vision

Make CodeSage AI a free, open, editor-native code reviewer that gives every developer
practical access to frontier models — without the project ever paying for inference, and
without the user hitting a wall mid-workday.

The mechanism is not unlimited tokens on any single model. It is a **quota-aware rotation
pool**: a deep pool of providers and models, routed intelligently, so that the supply is
effectively unlimited in normal use even though every individual quota in it is finite.

---

## 1. Current state

Today the extension is a TypeScript UI that spawns `code_review.py`, which calls a single
model through the HuggingFace `InferenceClient`. It is clean and well-structured, but it is
constrained on five axes.

### Provider lock-in
- `code_review.py:76-79` hardcodes `provider="together"` through HuggingFace.
- No base-URL setting, no second provider, a single key slot (`config.ts:5`).

### Model lock-in
- `package.json` declares a three-value `enum` of DeepSeek models; the settings UI cannot
  select anything outside it.
- Every new model requires a republish of the extension.

### Capacity caps
- `maxTokens` maximum `16384`, default `4096`; `temperature` capped at `1.5`.
- The input side has no budget at all: `reviewCode.ts:30` sends the entire file, so large
  files overflow the context window and fail.

### Scope caps
- One file, one selection, or one function. No workspace review, no git-diff or staged
  review, no PR review, no follow-up questions, no history, no caching.
- An unchanged file costs a full API call on every re-review.

### Reliability and runtime
- No retries, no timeouts, no fallback. A single 429 is a hard failure.
- Streaming errors are swallowed (`code_review.py:147-153`); malformed chunks are silently
  dropped (`reviewService.ts:186`).
- `tokens_used` is hardcoded to `0` in the streaming path (`code_review.py:174`), so usage
  reporting is inaccurate.
- Requires a local Python interpreter plus a manual `pip install huggingface_hub` (no
  dependency manifest exists), and `pythonPath` defaults to `python`, which is wrong on most
  macOS and Linux systems.
- No tests and no CI, despite `npm test` being wired to `vscode-test`.

---

## 2. Architecture decision

**Remove the Python subprocess.** Call an OpenAI-compatible endpoint directly from
TypeScript via `fetch`.

This one change:
- eliminates the Python dependency, which is the largest install-time drop-off;
- eliminates a process spawn per review;
- makes OmniRoute, OpenRouter, Anthropic, OpenAI and local Ollama the *same* code path,
  differing only by base URL.

`code_review.py` and its stdin/stdout JSON protocol are retired.

The default gateway is [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — an
MIT-licensed, self-hostable AI gateway exposing one OpenAI-compatible endpoint across a large
provider set, with quota-aware fallback built in.

---

## 3. The rotation pool

This is the core of the product, not a reliability afterthought.

### Pool depth
The usable ceiling is the sum of every reachable free tier, multiplied by the number of keys
a user supplies. One key on one provider hits a wall quickly; several providers each holding
the user's own key produces a pool that normal daily use does not exhaust. **Multi-key
support is the single largest lever on perceived limits** and lands early.

### Live quota accounting
The router must know what remains *before* dispatching:
- persist per-key quota state locally;
- decrement on use;
- parse `Retry-After` and `X-RateLimit-Reset` from 429 responses;
- mark a key cold until its window rolls over.

Blind retry-on-failure spends seconds probing dead providers on every request, which users
experience as a slow extension.

### Token economics
The cheapest token is the one never sent. Content-hash caching (never re-review unchanged
code), diff-only review, prompt compression, and context-aware chunking reduce consumption
substantially. Halving usage has the same effect on the ceiling as doubling the provider pool.

### Task-appropriate routing
Small function reviews route to fast, cheap models; whole-file and security-profile reviews
escalate to premium tiers. This saves quota and improves results at the same time, and it
preserves the premium budget for requests where the difference is visible.

### Tiering and transparency
Blind rotation produces a quality cliff: an excellent review at 09:00 and a shallow one at
09:05 reads as a broken product, not as an exhausted quota. Therefore:

- rotate *within* a quality tier first; drop a tier only when the entire tier is cold;
- always display the model that produced the review — `reviewPanel.ts:176` already renders a
  model badge, it simply needs to be fed the actual model rather than the configured one;
- when a tier drops, state it once, quietly, with a reason and an expected recovery window.

Degradation the user understands is a feature. Degradation they cannot see is a bug.

### Boundary
Rotating across providers using keys the user legitimately holds is standard practice.
Programmatically creating accounts to farm a single provider's free tier is not: it gets keys
revoked and risks the extension's marketplace listing. The design is explicitly
bring-your-own-key.

---

## 4. Phases

### P0 — Remove Python
Native TypeScript streaming SSE client. New settings: `baseUrl`, `apiKey`, provider preset.
Presets for OmniRoute (default), OpenRouter, Anthropic, OpenAI, Ollama/local. Delete
`code_review.py`.
*Outcome: zero-install extension, any provider.*

### P1 — Dynamic model catalog
Replace the model `enum` with a live picker backed by `GET /models`, cached locally. Raise
`maxTokens` to the model's real ceiling read from the catalog rather than a constant. Correct
`tokens_used` reporting.
*Outcome: new models become available the day they ship, with no republish — which is also
what keeps the rotation pool's targets current.*

### P2 — Rotation engine
Per-key quota ledger, tier definitions, tier-aware fallback chains, cooldown tracking, 429
header parsing, multi-key management UI, and honest model attribution in the review panel.
*Outcome: the pool behaves as effectively unlimited under normal use.*

### P3 — Token economics
Content-hash cache, diff-only review, prompt compression, task-complexity routing.
*Outcome: multiplies P2's effective ceiling without adding providers.*

### P4 — Scope
Token-aware chunking so large files review correctly. Review the git diff, staged changes,
the workspace, and pull requests.

### P5 — Product depth
Follow-up conversation on any finding, persistent review history, diff-based quick-fixes in
place of string insertion, and a usage dashboard.

### P6 — Trust and distribution
Tests (the harness is installed and unused), GitHub Actions CI, secret redaction before any
code leaves the machine, an explicit privacy statement. Rebrand off "(DeepSeek)" in
`displayName`. Publish to OpenVSX alongside the VS Code Marketplace to reach
Cursor/Windsurf/VSCodium users.

---

## 5. Open decisions

1. **OmniRoute self-hosted or cloud endpoint?** Self-hosted is free and private; cloud is
   zero-setup for users.
2. **Key ownership.** Recommended: bring-your-own-key with a strong setup wizard, plus
   no-signup free providers as a zero-config fallback so the extension works on install with
   no key at all.
3. **Ship P0 and P1 together, or P0 alone first** to deliver the zero-install win sooner.
