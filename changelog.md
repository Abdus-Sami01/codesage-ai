# Changelog

All notable changes to CodeSage AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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