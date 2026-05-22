<div id="cerberus-logo" align="center">
    <br />
    <img src="./icons/stable/codium_cnl.svg" alt="Cerberus Logo" width="200"/>
    <h1>Cerberus</h1>
    <h3>AI-native code editor by AiwebModel</h3>
</div>

Cerberus is a custom distribution of the Code OSS source tree, rebranded and bundled with a built-in `cerberus-ai` extension that wires the editor's AI experience directly into AiwebModel's model gateway.

This repository is a downstream of [VSCodium](https://github.com/VSCodium/vscodium), which itself is a build pipeline around [microsoft/vscode](https://github.com/microsoft/vscode). We keep `upstream` pointing at VSCodium so we can pull patch and version bumps as they land.

## Brand identity

| Field | Value |
| --- | --- |
| App name | `Cerberus` |
| Binary / CLI | `cerberus` |
| Org name | `AiwebModel` |
| GitHub repo | `aiwebmodel/cerberus` |
| Tunnel app | `cerberus-tunnel` |
| Bundle id (macOS) | `com.aiwebmodel.Cerberus` |
| URL protocol | `cerberus://` |
| User data dir | `~/.config/Cerberus` (Linux), `%APPDATA%\Cerberus` (Windows), `~/Library/Application Support/Cerberus` (macOS) |

These come from [`utils.sh`](./utils.sh) and [`prepare_vscode.sh`](./prepare_vscode.sh). Override per-build via env vars (`APP_NAME`, `BINARY_NAME`, `ORG_NAME`, `GH_REPO_PATH`, `CERBERUS_AI_API_BASE_URL`, ...).

## Built-in Cerberus AI

The `cerberus-ai` extension ships in `extensions/cerberus-ai` and is copied into `vscode/extensions/cerberus-ai` during `prepare_vscode.sh`. It registers Cerberus's own models with VS Code's Language Model and Chat APIs so any chat/inline-completion surface in the editor talks to your gateway by default.

Provider config lives in `product.json` keys:

- `cerberusAiApiBaseUrl` (default `https://api.aiwebmodel.com/v1`)
- `cerberusAiHomepageUrl`
- `cerberusAiDefaultModels`

Users can also override the endpoint and API key per-machine via settings:

- `cerberusAi.apiBaseUrl`
- `cerberusAi.apiKey` (stored in the OS secret store)
- `cerberusAi.defaultModel`

## Build

Same flow as VSCodium:

```bash
export VSCODE_QUALITY="stable"
export OS_NAME="linux"            # or "osx" / "windows"
export VSCODE_ARCH="x64"
export RELEASE_VERSION="1.0.0"
export SHOULD_BUILD="yes"

./get_repo.sh
./build.sh
```

For day-to-day hacking: `./dev/build.sh` (Linux/macOS) or PowerShell equivalent on Windows. See [`docs/howto-build.md`](./docs/howto-build.md).

## Update from upstream

```bash
git fetch upstream
git merge upstream/master
```

Resolve conflicts (mostly in this README, `utils.sh`, and `prepare_vscode.sh`) and re-run the build.

## License

MIT, inherited from VSCodium and Code OSS. See [`LICENSE`](./LICENSE).
