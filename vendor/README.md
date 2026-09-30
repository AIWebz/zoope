# Vendored files

These files are bundled so zoope runs fully offline, with no API calls.

- `mediapipe/`: `@mediapipe/tasks-vision` 1.0.1 (Apache-2.0, © Google LLC). This is the JS bundle plus the WebAssembly runtime (SIMD and non-SIMD builds).
- `models/face_landmarker.task`: the MediaPipe Face Landmarker model (float16, v1, Apache-2.0). It finds 478 points on a face.
