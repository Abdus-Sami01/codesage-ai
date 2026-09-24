# Changelog

All notable changes to CodeSage AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] - 2026-09-25

### Added
- CodeSage panel in the activity bar: connection setup with a Test button, key management, live model picker with a free-only filter, one-click reviews, rotation pool status and review history
- `CodeSage: Review File` from the editor title bar and the explorer right-click menu
- `CodeSage: Review Uncommitted Changes` reviews the git diff of the workspace, also from the Source Control title bar
- Getting-started walkthrough and a one-time setup prompt when nothing is configured
- Provider presets for OpenRouter, OpenAI, Ollama and self-hosted gateways via `codesage-ai.provider`
- `codesage-ai.baseUrl` for pointing at any OpenAI-compatible endpoint
- Model rotation: `codesage-ai.routes` ranks any number of models, and a review walks the pool in tier order until one answers
- Multiple API keys per provider, so capacity is routes multiplied by keys
- Quota ledger that records each provider's own `Retry-After` and `X-RateLimit-Reset` hints and persists them across window reloads
- `CodeSage: Select Model` picks from the provider's live `/models` catalog instead of typing an identifier by hand
- `CodeSage: Manage API Keys` adds and removes pooled credentials
- `CodeSage: Show Rotation Pool` lists every route, its state, and when a paused one recovers
- `codesage-ai.requestTimeoutMs`, `codesage-ai.maxAttempts` and `codesage-ai.maxQueueWaitMs`
- Reviews served by a fallback model say so, in a notification and in the panel header
- Unit tests covering SSE decoding, provider payload parsing, rotation ordering, quota accounting and reset-header parsing

### Changed
- Reviews are requested directly from TypeScript over HTTP; Python and `huggingface_hub` are no longer required to run the extension
- `codesage-ai.model` accepts any model identifier instead of three fixed choices, and defaults to `openrouter/free`
- `CodeSage: Review Function` honours `codesage-ai.enableStreaming` like `Review Code` already did
- `codesage-ai.maxTokens` accepts up to 131072, and `codesage-ai.temperature` up to 2
- Gateways on `localhost` or a private address are reachable with no API key at all
- The API key prompt asks which provider the key is for instead of requiring a HuggingFace `hf_` prefix

### Fixed
- Reviewing a selection put inline diagnostics on the wrong lines; they now line up with the selected code
- A failed streamed review left the panel spinning on "Analyzing"; it now shows the error
- `codesage-ai.temperature` is now sent to the provider; previously it was read from settings and silently discarded
- Token usage is reported from the provider response instead of always showing zero on streamed reviews
- Provider and transport failures surface the status code and response body instead of a generic subprocess error
- A rate limit no longer ends the session: the next route takes over, and the exhausted one is skipped until it recovers
- A request that goes silent is aborted instead of hanging forever; while streaming the deadline restarts on every chunk
- The panel header reports the model that actually answered rather than the one named in settings

### Removed
- `codesage-ai.pythonPath`, which no longer has any effect

## [0.2.0] - 2026-05-10

### Added
- Inline diagnostics: AI issues rendered as native VS Code squiggly underlines
- Quick-fix CodeActions: apply AI-suggested fixes with one click
- CodeLens: "Review" buttons above functions, methods, and classes
- Four review profiles: General, Security, Performance, Clean Code
- Status bar integration with profile indicator and review spinner
- Streaming responses: real-time review rendering as the AI generates
- Profile quick-pick switcher via status bar or command palette
- Dismiss individual diagnostics via CodeAction

### Changed
- Review service now supports both streaming and batch modes
- Python backend accepts system prompt and stream mode via environment variables
- Webview panel shows issue count badge in header

## [0.1.0] - 2026-05-10

### Added
- TypeScript architecture with esbuild bundling
- AI-powered code review via DeepSeek R1 (HuggingFace)
- Webview panel with theme-aware, markdown-rendered results
- Secure API key management via VS Code SecretStorage
- Configurable settings: model, max tokens, temperature, Python path
- Keyboard shortcut: Ctrl+Shift+R for instant review
- Support for reviewing selected code or entire files
- Progress notification with cancellation support
- Output channel logging for diagnostics

### Removed
- Hardcoded API key (security fix)
- Direct stdout printing (replaced with structured JSON protocol)