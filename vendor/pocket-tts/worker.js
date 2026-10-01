/**
 * All of the model work, off the main thread.
 *
 * onnxruntime-web runs its wasm synchronously on whichever thread calls it, so
 * doing this on the page froze React and starved the audio clock — the symptom
 * was a stalled status line on a fast machine and gappy, syllable-by-syllable
 * playback on a slow one. Here the page only ever receives finished frames.
 *
 * The thinking all lives in `pipeline.ts`, which knows nothing about workers;
 * this file is the postMessage protocol and nothing else.
 */
import { Pipeline } from "./pipeline.js";
let pipeline = null;
/** The last clone, kept here so a page can refer to it without shipping it back. */
let cloned = null;
let cancelled = false;
const post = (message, transfer = []) => self.postMessage(message, transfer);
const ready = () => {
    if (!pipeline)
        throw new Error("the model has not been loaded");
    return pipeline;
};
/** A cloned voice travels as an array; use the one the encoder actually made. */
const resolveVoice = (voice) => voice instanceof Float32Array ? (cloned ?? voice) : voice;
async function load(id, options) {
    pipeline = await Pipeline.load({
        ...options,
        onProgress: (stage, progress) => post({ id, kind: "progress", stage, progress }),
    });
    post({
        id,
        kind: "ready",
        modelsUrl: pipeline.modelsUrl,
        manifest: pipeline.manifest,
        hasPhonemes: pipeline.hasPhonemes,
        defaultVoice: pipeline.defaultVoice,
        defaults: pipeline.defaults,
    });
}
async function speak(request) {
    const { id, text, decodeSteps, temperature, seed, debug } = request;
    const frames = ready().stream(text, {
        voice: resolveVoice(request.voice),
        decodeSteps,
        temperature,
        seed,
        debug,
        onStatus: (status) => post({ id, kind: "status", status }),
        onProgress: (stage, progress) => post({ id, kind: "progress", stage, progress }),
        onDebug: (payload) => post({ id, kind: "debug", debug: payload }),
    });
    for await (const frame of frames) {
        if (cancelled)
            break;
        const copy = frame.slice();
        post({ id, kind: "frame", frame: copy }, [copy.buffer]);
    }
    post({ id, kind: "done" });
}
async function clone(request) {
    const pipe = ready();
    cloned = await pipe.clone(request.samples, {
        onProgress: (stage, progress) => post({ id: request.id, kind: "progress", stage, progress }),
    });
    post({
        id: request.id,
        kind: "cloned",
        name: "cloned",
        seconds: Math.min(request.samples.length / pipe.sampleRate, 20),
    });
}
async function prepare(request) {
    if (!pipeline)
        return;
    await pipeline.prepare(resolveVoice(request.voice), request.phonemes);
    post({ id: request.id, kind: "prepared" });
}
self.onmessage = async (event) => {
    const request = event.data;
    if (request.kind === "cancel") {
        cancelled = true;
        return;
    }
    try {
        cancelled = false;
        if (request.kind === "load")
            await load(request.id, request.options);
        else if (request.kind === "speak")
            await speak(request);
        else if (request.kind === "clone")
            await clone(request);
        else if (request.kind === "prepare")
            await prepare(request);
    }
    catch (cause) {
        post({
            id: request.id,
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
        });
    }
};
