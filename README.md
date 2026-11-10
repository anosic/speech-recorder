# Anosic Speech Recorder

A VS Code extension that records your voice, transcribes it with a local AI model, and copies the text to your
clipboard. Audio never leaves your machine: capture runs in a small native helper, and transcription runs a
Whisper model through ONNX Runtime inside the extension.

See the [extension README](apps/vscode-ext-speech/README.md) for features and settings.

**Platforms:** Linux x64 (including WSL2) today. **macOS is the top priority**: Apple Silicon first, then Intel.
See [platform support](apps/vscode-ext-speech/README.md#platform-support).

## Layout

| Path | What it is |
|---|---|
| [`apps/vscode-ext-speech/`](apps/vscode-ext-speech/README.md) | The VS Code extension (TypeScript). Transcription, UI, clipboard. |
| [`apps/speech-capture/`](apps/speech-capture/README.md) | Native microphone capture helper (Rust). Writes 16 kHz mono PCM to stdout. |

## Install from a release

Download the `.vsix` for your platform from the
[releases page](https://github.com/anosic/speech-recorder/releases) and install it:

```sh
code --install-extension speech-recorder-linux-x64-<version>.vsix
```

The package is platform-specific, because it ships the native capture helper and the ONNX Runtime binding.

## Build from source

Requirements: Rust (stable; `rust-toolchain.toml` selects it), Node.js 20 or later, and Yarn 4 (via
`corepack enable`). On Linux, the ALSA headers too: `sudo apt install libasound2-dev pkg-config`.

```sh
# 1. Native capture helper → target/release/speech-capture
cargo build --release -p speech-capture

# 2. Extension dependencies
yarn install

# 3. Stage a self-contained extension in apps/vscode-ext-speech/build/vsix/
yarn workspace speech-recorder package

# 4. Package it (the staging step prints this exact command for your platform)
cd apps/vscode-ext-speech/build/vsix
yarn dlx @vscode/vsce package --no-dependencies --target linux-x64 --out ../speech-recorder-linux-x64-<version>.vsix
```

A VSIX built on a machine runs on that machine's platform and architecture only.

### Developing

Open `apps/vscode-ext-speech/` in VS Code and press F5 (**Run Extension**). That compiles with `tsc` and starts an
Extension Development Host. In a source checkout, the extension finds the capture helper in `target/release/` (or
`target/debug/`).

```sh
cargo test -p speech-capture
yarn workspace speech-recorder typecheck
```

## License

[MIT](LICENSE)
