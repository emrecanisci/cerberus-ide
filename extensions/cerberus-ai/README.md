# Cerberus AI

Built-in AI provider for Cerberus. Registers AiwebModel's hosted models with the editor's Language Model and Chat APIs.

This extension is shipped in-the-box and cannot be uninstalled, but it can be disabled per-workspace.

## How it works

- On activation it reads `cerberusAiApiBaseUrl` and `cerberusAiDefaultModels` from `product.json`.
- For each model in `cerberusAiDefaultModels` it registers a `vscode.LanguageModelChatProvider`.
- Requests are streamed over Server-Sent Events to `${apiBaseUrl}/chat/completions` (OpenAI-compatible).
- The API key is stored via `vscode.SecretStorage` (`cerberusAi.apiKey`).

## Settings

| Setting | Description |
| --- | --- |
| `cerberusAi.apiBaseUrl` | Override gateway URL (defaults to `product.json`). |
| `cerberusAi.defaultModel` | Default model id picked in chat surfaces. |
| `cerberusAi.requestTimeoutMs` | Per-request timeout. |

## Commands

- `Cerberus AI: Sign In` — store an API key.
- `Cerberus AI: Sign Out` — clear the stored key.
- `Cerberus AI: Set API Base URL` — override the endpoint at runtime.
