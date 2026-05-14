# CodeSage AI

AI-powered code reviews inside VS Code. Get instant, expert-level feedback on bugs, security, performance, and code quality -- powered by DeepSeek via HuggingFace.

## Features

- **AI Code Reviews** -- Analyze any file or selection and get structured, actionable feedback with severity ratings, line references, and code fix suggestions.
- **Inline Diagnostics** -- Issues appear as native VS Code squiggly underlines. Click the lightbulb to apply AI-suggested fixes in one click.
- **CodeLens Integration** -- "Review" buttons appear above every function, method, and class. Click to review a single function in isolation.
- **Review Profiles** -- Four specialized modes tailor the AI's focus:
  - **General** -- Balanced review: bugs, security, performance, readability
  - **Security** -- OWASP-focused audit: injection, secrets, auth, cryptography
  - **Performance** -- Bottleneck analysis: complexity, memory, I/O, caching
  - **Clean Code** -- Craftsmanship: SOLID, DRY, naming, nesting, refactoring
- **Streaming Responses** -- Reviews render in real-time as the AI generates them, so you see results immediately.
- **Multi-Language** -- Works with Python, JavaScript, TypeScript, C++, Java, Go, Rust, PHP, and any language with VS Code symbol support.
- **Secure** -- API keys stored in VS Code's encrypted SecretStorage. Never written to files.

## Installation

### From Source

```bash
git clone https://github.com/Abdus-Sami01/codesage-ai.git
cd codesage-ai/extension
npm install
npm run build
```

Press `F5` in VS Code to launch the Extension Development Host.

### Prerequisites

- **VS Code** 1.97.0 or higher
- **Python 3.8+** with `huggingface_hub` installed:
  ```bash
  pip install huggingface_hub
  ```
- **HuggingFace API Key** -- Get one at https://huggingface.co/settings/tokens

## Quick Start

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **CodeSage: Set API Key** and paste your HuggingFace token
3. Open any code file
4. Press `Ctrl+Shift+R` or run **CodeSage: Review Code**
5. View the review in the panel that opens beside your editor

Issues will also appear as inline diagnostics (squiggly underlines) in the editor. Hover over them and click the lightbulb to apply fixes.

## Settings

| Setting | Default | Description |
|---|---|---|
| `codesage-ai.model` | `deepseek-ai/DeepSeek-R1` | AI model for reviews |
| `codesage-ai.maxTokens` | `4096` | Maximum response length |
| `codesage-ai.temperature` | `0.3` | Response creativity (0 to 1.5) |
| `codesage-ai.pythonPath` | `python` | Path to Python interpreter |
| `codesage-ai.reviewProfile` | `general` | Review focus: general, security, performance, clean-code |
| `codesage-ai.enableCodeLens` | `true` | Show Review buttons above functions |
| `codesage-ai.enableStreaming` | `true` | Stream results in real-time |

## Commands

| Command | Shortcut | Description |
|---|---|---|
| CodeSage: Review Code | `Ctrl+Shift+R` | Review the active file or selection |
| CodeSage: Review Function | -- | Review a single function (via CodeLens) |
| CodeSage: Set API Key | -- | Store your HuggingFace API key securely |
| CodeSage: Select Review Profile | -- | Switch between review profiles |

## Architecture

```
VS Code Extension (TypeScript)
  |
  |-- reviewCode.ts / reviewFunction.ts  (commands)
  |-- reviewService.ts                    (spawns Python subprocess)
  |-- reviewPanel.ts                      (Webview rendering)
  |-- diagnosticsProvider.ts              (inline squiggly lines)
  |-- codeLensProvider.ts                 (Review buttons on functions)
  |-- statusBar.ts                        (profile indicator)
  |
  v
code_review.py (Python backend)
  |
  |-- Reads JSON from stdin
  |-- Calls HuggingFace API (DeepSeek model)
  |-- Writes JSON to stdout (streaming or batch)
```

## Development

```bash
npm install          # Install dependencies
npm run watch        # Build + watch for changes
npm run build        # One-time build
npm run build:prod   # Production build (minified)
npm run lint         # Run ESLint
npm run package      # Create .vsix package
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

## License

[MIT](LICENSE.txt)
