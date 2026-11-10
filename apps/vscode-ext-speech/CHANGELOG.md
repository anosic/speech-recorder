# Changelog

Notable changes to Anosic Speech Recorder. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-09

First public release.

### Added

- Dictation: record from the microphone with **Ctrl+Alt+R** (Cmd+Alt+R on macOS) or the status bar microphone, and get
  a Whisper transcript when you stop. Keyboard focus stays where it was.
- **Change Keyboard Shortcut…** (keyboard icon in the panel title) opens Keyboard Shortcuts filtered to Toggle
  Recording, to bind it to another key.
- Local transcription: audio is captured and transcribed on your machine and never uploaded. The model is downloaded
  once from Hugging Face on first use.
- **Model** setting with presets: Tiny (\~41 MB), Base (\~77 MB), Small (\~249 MB, default) and Large v3 Turbo
  (\~1.09 GB), each showing its download size. **Custom** uses any ONNX Whisper model id and weight variant.
- Copy to the clipboard as soon as the transcript is ready (`anosicSpeech.autoCopy`, on by default).
- Auto-clear for privacy (`anosicSpeech.autoClear`, on by default): the transcript is cleared 10 minutes after each
  transcription (`anosicSpeech.autoClearTimeoutMinutes`), along with the clipboard if it still holds the transcript.
  The status bar counts down the time left.
- Sidebar panel in the Explorer: Record / Stop, a level meter, the transcript, Copy, Clear, and transcription of
  existing WAV files.
- Silence detection: near-silent recordings are reported instead of transcribed, since Whisper invents short phrases
  for silence.
- Optional noise suppression and automatic gain control during capture, and a choice of input device.
- Linux x64 packages, including WSL2.
