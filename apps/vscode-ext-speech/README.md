# Anosic Speech Recorder

Dictate into VS Code. Record from your microphone, get a Whisper transcript, and have it on the clipboard ready to
paste, all on your own machine.

## Platform support

| Platform | Status |
|---|---|
| Linux x64, including WSL2 | Supported |
| macOS, Apple Silicon | **Top priority, next up.** |
| macOS, Intel | Planned right after Apple Silicon. |
| Windows | Not yet tested. |

If you're on a Mac and want to help test, or want to know when it lands, open or follow an issue at
[github.com/anosic/speech-recorder](https://github.com/anosic/speech-recorder/issues).

## Features

- **Toggle Recording** with **Ctrl+Alt+R** (Cmd+Alt+R on macOS), or by clicking the microphone in the status bar.
  The shortcut never moves keyboard focus, so you can dictate while focus stays in a chat input or an editor.
  To use a different key, click the keyboard icon in the panel title (or run **Anosic Speech Recorder: Change Keyboard
  Shortcut…**), which opens Keyboard Shortcuts filtered to **Toggle Recording**.
- **Transcribe on stop.** The whole recording is transcribed when you stop, and the model is loaded while you are
  still talking. Recordings that are effectively silent are reported as silence rather than transcribed, because
  Whisper tends to invent short phrases for silence.
- **Copied automatically.** With `anosicSpeech.autoCopy` on (the default) the transcript goes to the clipboard as
  soon as it is ready. The **Copy** button reads **Copied!** only while the clipboard holds exactly the full
  transcript.
- **Cleared automatically.** With `anosicSpeech.autoClear` on (the default) the transcript is cleared 10 minutes
  after each transcription (`anosicSpeech.autoClearTimeoutMinutes`), so dictated text isn't left behind. The
  clipboard is emptied too if it still holds the transcript. The status line shows when the clear will happen, and a
  new transcription restarts the timer.
- **Sidebar panel** (*Anosic Speech Recorder*, in the Explorer): Record / Stop, a level meter, the transcript, **Copy**,
  **Clear** (empties the transcript, and the clipboard too if it still holds the transcript; anything you copied
  since is left alone), and **Transcribe WAV file…** for existing recordings.
- **Status bar item**: a microphone when idle, `REC m:ss` while recording, a spinner while transcribing, and
  *Copied* while the clipboard holds the transcript. Hover for the full status; click to toggle recording.
- The keyboard icon in the panel title changes the shortcut, and the gear icon opens the settings. Logs are in **Output › Anosic Speech Recorder**.

## Privacy and downloads

Audio is captured and transcribed locally; it is never uploaded. The speech model is downloaded once from Hugging
Face on first use (the default, `small`, is about 249 MB) and cached in the extension's
storage, or in `anosicSpeech.modelCacheDir` if you set it.

Transcripts are kept in memory only, never written to disk. By default they are cleared 10 minutes after each
transcription, along with the clipboard if it still holds the transcript; the status line shows when. Clipboard history
tools (such as Windows' Win+V history) may keep their own copy, which the extension can't reach.

## What's in the package

Everything needed to record and transcribe ships in the extension package, except the speech model. The download is
about 19 MB and unpacks to about 49 MB. Sizes below are for Linux x64; other platforms are similar.

| Component | Size | What it does |
|---|---|---|
| ONNX Runtime | ~46 MB | Microsoft's inference engine. Runs the Whisper model on your CPU. |
| Transcription worker | ~1.5 MB | Hugging Face Transformers.js, bundled: audio features, decoding, model loading. |
| `speech-capture` | ~1.2 MB | Native microphone helper (Rust): capture, optional noise suppression and gain control, conversion to 16 kHz mono. |
| ONNX Runtime binding | ~0.4 MB | Connects Node.js to ONNX Runtime. |
| Extension | ~20 KB | The VS Code side: commands, sidebar panel, status bar, clipboard. |

The speech model is not in the package. It is downloaded on first use (see above) and is larger than everything in
this table combined.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `anosicSpeech.autoClear` | `true` | Clear the transcript (and the clipboard, if it still holds it) a while after each transcription. |
| `anosicSpeech.autoClearTimeoutMinutes` | `10` | Minutes until that happens. Used only when `autoClear` is on. |
| `anosicSpeech.autoCopy` | `true` | Copy the transcript to the clipboard as soon as it is ready. |
| `anosicSpeech.model` | `small` | Speech model: `tiny` (\~41 MB), `base` (\~77 MB), `small` (\~249 MB), `large-v3-turbo` (\~1.09 GB), or `custom`. Larger is more accurate and slower. |
| `anosicSpeech.customModel` | *(empty)* | With `custom`: Hugging Face id of an ONNX Whisper model. |
| `anosicSpeech.customDtype` | `q8` | With `custom`: weight variant (`q8`, `int8`, `uint8`, `q4`, `bnb4`, `fp16`, `fp32`). |
| `anosicSpeech.customRevision` | `main` | With `custom`: model revision (commit or branch) to pin. |
| `anosicSpeech.modelCacheDir` | *(extension storage)* | Where downloaded model files are kept. |
| `anosicSpeech.inputDevice` | *(default device)* | Microphone to record from, by name. |
| `anosicSpeech.noiseSuppression` | `false` | Noise suppression during capture. |
| `anosicSpeech.autoGain` | `false` | Automatic gain control during capture. |
| `anosicSpeech.captureBinary` | *(bundled)* | Override the bundled `speech-capture` binary. |

## Requirements

A working microphone. The extension runs on the machine where your workspace lives (for remote and WSL windows,
the remote side), and its package is platform-specific because it ships native audio and inference libraries.
