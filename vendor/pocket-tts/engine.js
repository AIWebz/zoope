/**
 * The page's side of the worker.
 *
 * Everything heavy — the model, the phonemizers, the voice encoder — lives in
 * `worker.ts`. This turns that into promises and an async iterator, so the page
 * never blocks and audio frames arrive while the main thread is free to play
 * them.
 */
export class Engine {
    worker;
    modelsUrl;
    manifest;
    hasPhonemes;
    defaultVoice;
    defaults;
    next = 1;
    handlers = new Map();
    constructor(worker, 
    /** The folder this engine's model came from, for telling two apart. */
    modelsUrl, manifest, hasPhonemes, defaultVoice, defaults) {
        this.worker = worker;
        this.modelsUrl = modelsUrl;
        this.manifest = manifest;
        this.hasPhonemes = hasPhonemes;
        this.defaultVoice = defaultVoice;
        this.defaults = defaults;
        worker.onmessage = (event) => {
            this.handlers.get(event.data.id)?.(event.data);
        };
    }
    static async load({ onProgress, worker: given, ...options } = {}) {
        const worker = typeof given === "function"
            ? given()
            : (given ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
        return new Promise((resolve, reject) => {
            const id = 0;
            worker.onmessage = (event) => {
                const message = event.data;
                if (message.kind === "progress")
                    onProgress?.(message.stage, message.progress);
                else if (message.kind === "ready") {
                    resolve(new Engine(worker, message.modelsUrl, message.manifest, message.hasPhonemes, message.defaultVoice, message.defaults));
                }
                else if (message.kind === "error")
                    reject(new Error(message.message));
            };
            worker.onerror = (event) => reject(new Error(event.message || "the worker failed to start"));
            worker.postMessage({ id, kind: "load", options });
        });
    }
    /** Drop the worker and the model in it, to make room for another. */
    dispose() {
        this.worker.terminate();
        this.handlers.clear();
    }
    get sampleRate() {
        return this.manifest.sampleRate;
    }
    get voices() {
        return this.manifest.voices;
    }
    /** Yield 80 ms frames as the worker decodes them. */
    async *speak(text, voice, options = {}) {
        const id = this.next++;
        const queue = [];
        let done = false;
        let failure = null;
        let wake = null;
        this.handlers.set(id, (message) => {
            if (message.kind === "frame")
                queue.push(message.frame);
            else if (message.kind === "status")
                options.onStatus?.(message.status);
            else if (message.kind === "progress")
                options.onProgress?.(message.stage, message.progress);
            else if (message.kind === "debug")
                options.onDebug?.(message.debug);
            else if (message.kind === "done")
                done = true;
            else if (message.kind === "error") {
                failure = new Error(message.message);
                done = true;
            }
            wake?.();
        });
        this.worker.postMessage({
            id,
            kind: "speak",
            text,
            voice,
            decodeSteps: options.decodeSteps ?? 2,
            temperature: options.temperature,
            seed: options.seed,
            debug: options.debug ?? false,
        });
        try {
            for (;;) {
                while (queue.length)
                    yield queue.shift();
                if (failure)
                    throw failure;
                if (done)
                    return;
                await new Promise((resolve) => (wake = resolve));
                wake = null;
            }
        }
        finally {
            this.handlers.delete(id);
        }
    }
    /** Encode a voice prompt; the worker keeps it and uses it for later calls. */
    async clone(samples, onProgress) {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.handlers.set(id, (message) => {
                if (message.kind === "progress")
                    onProgress?.(message.stage, message.progress);
                else if (message.kind === "cloned") {
                    this.handlers.delete(id);
                    resolve({ seconds: message.seconds, cond: message.cond });
                }
                else if (message.kind === "error") {
                    this.handlers.delete(id);
                    reject(new Error(message.message));
                }
            });
            const copy = samples.slice();
            this.worker.postMessage({ id, kind: "clone", samples: copy }, [copy.buffer]);
        });
    }
    /** zoope: use a clone saved earlier, without the encoder. */
    setVoice(cond) {
        const id = this.next++;
        return new Promise((resolve, reject) => {
            this.handlers.set(id, (message) => {
                this.handlers.delete(id);
                if (message.kind === "voiceSet") resolve();
                else reject(new Error(message.message || "could not set the voice"));
            });
            const copy = cond.slice();
            this.worker.postMessage({ id, kind: "setVoice", cond: copy }, [copy.buffer]);
        });
    }
    /** Warm a voice ahead of a take; failures are not worth reporting. */
    prepare(voice, phonemes) {
        const id = this.next++;
        this.handlers.set(id, (message) => {
            if (message.kind === "prepared" || message.kind === "error")
                this.handlers.delete(id);
        });
        this.worker.postMessage({ id, kind: "prepare", voice, phonemes });
    }
    cancel() {
        this.worker.postMessage({ id: -1, kind: "cancel" });
    }
}
