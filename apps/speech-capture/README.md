# speech-capture

Capture-only microphone helper for the [Anosic Speech Recorder VS Code extension](../vscode-ext-speech/README.md).
Transcription happens in the extension (ONNX Whisper); this binary only captures, optionally applies `sonora`
noise suppression and gain control, and converts to Whisper's input format.

## Protocol

| Stream | Content |
|---|---|
| stdout | Raw 16 kHz mono PCM, 32-bit float little-endian. Nothing else. |
| stderr | One JSON object per line: `ready` (device, rate, channels, format), `level` (RMS and peak every 100 ms), `error`, `stopped` (sample count). Audio libraries may also print non-JSON lines here; consumers should log and ignore them. |
| stdin  | Capture runs until stdin reaches EOF. Closing it is the stop signal: buffered audio is flushed, `stopped` is emitted and the process exits 0. If the parent dies, its end of the pipe closes and capture stops the same way. |

Where the device offers 16 kHz natively (PulseAudio under WSLg does) the sound server resamples. Otherwise the
device default is used and a streaming windowed-sinc low-pass plus linear resampler converts to 16 kHz, with filter
state carried across chunks.

## Commands

```sh
cargo build --release -p speech-capture
cargo test -p speech-capture

target/release/speech-capture --list-devices
# 3 s capture to a file (stops when the subshell closes stdin):
(sleep 3) | target/release/speech-capture > /tmp/capture.f32
```

On Linux the build needs the ALSA headers (`sudo apt install libasound2-dev pkg-config` on Debian/Ubuntu).

Under WSL2 the microphone comes through WSLg's PulseAudio server. `speech-capture` points `PULSE_SERVER` at
`/mnt/wslg/PulseServer` when that socket exists and the variable is unset, so no setup is usually needed; if
`--list-devices` shows nothing, check that the socket exists (`ls -la /mnt/wslg/PulseServer`).
