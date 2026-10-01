# Vendored files

These files are bundled so zoope runs fully offline, with no API calls.

- `mediapipe/`: `@mediapipe/tasks-vision` 1.0.1 (Apache-2.0, © Google LLC). This is the JS bundle plus the WebAssembly runtime (SIMD and non-SIMD builds).
- `models/face_landmarker.task`: the MediaPipe Face Landmarker model (float16, v1, Apache-2.0). It finds 478 points on a face.
- `fonts/`: Geist Sans and Geist Mono variable fonts (SIL Open Font License 1.1, © Vercel). See `fonts/OFL.txt`.
- `three/`: three.js r186 (`three.module.js`, `three.core.js`) (MIT, © three.js authors). Renders the live avatar.
- `onnxruntime/`: onnxruntime-web 1.29 WebAssembly build (MIT, © Microsoft). Runs the neural voice model.
- `pocket-tts/`: pocket-tts-onnx 0.1.0 (CC BY 4.0, © thewh1teagle), the browser runtime for Kyutai's Pocket TTS. Its imports are rewritten to local paths so it runs without a bundler.

The Pocket TTS weights (~216 MB, CC BY 4.0, Kyutai) are too large for git. zoope downloads them from Hugging Face the first time someone creates a neural voice, and the browser caches them. To self-host them, place the `en/` folder from https://huggingface.co/thewh1teagle/pocket-tts-onnx in `models/pocket-tts/en/`. zoope uses that folder automatically when `manifest.json` is present.

- `espeak-ng/`: eSpeak NG 1.0.2 compiled to WebAssembly (npm `espeak-ng`, GPL-3.0-or-later, see `espeak-ng/LICENSE`). Speech synthesizer behind the light voice.
- `transformers/`: transformers.js 4.3.0 (`transformers.min.js.gz`, gzipped; Apache-2.0) with onnxruntime-web 1.31 dev WebAssembly builds (MIT). Runs the in-browser language model.
