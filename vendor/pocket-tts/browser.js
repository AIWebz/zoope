/**
 * The parts that only make sense in a page.
 *
 * A worker to keep the model off the main thread, an AudioContext to play
 * frames as they arrive, a microphone to clone from, and a `Blob` for the
 * download link. Import from `pocket-tts-onnx` instead if you only want to
 * turn text into samples.
 */
export { Engine } from "./engine.js";
export { CEILING_DB, FramePlayer, TARGET_RMS_DB, decodeAudioFile, encodeWavBlob, gained, measure, normalGain, resample, } from "./audio.js";
export { Recorder } from "./recorder.js";
