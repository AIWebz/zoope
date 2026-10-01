/**
 * The whole of speaking, in one object, on whatever thread you call it from.
 *
 * This is the logic that used to live inside the web worker: fetch the model,
 * decide whether a line needs the phoneme adapter, run the phonemizers it
 * needs, and stream frames. None of it touches the DOM, a Worker or an
 * AudioContext, so a Node script and a page can share it — the page just puts
 * `worker.ts` in front so the main thread stays free.
 */
import { fetchAsset, fetchJson } from "./assets.js";
import { loadEspeak, phonemizeEnglish } from "./espeak.js";
import { HebrewG2P } from "./g2p.js";
import { language as languageByName } from "./languages.js";
import { phonemizeMixed } from "./mixed.js";
import { resolveOptions } from "./options.js";
import { PocketTTS } from "./tts.js";
const HEBREW = /[֐-׿]/;
const LATIN = /\p{Script=Latin}/u;
const LITERAL = /\[\[[\s\S]*?\]\]/;
const LITERAL_BODY = /\[\[([\s\S]*?)\]\]/g;
export class Pipeline {
    tts;
    config;
    manifest;
    defaultVoice;
    g2p = null;
    espeakReady = false;
    encoderLoaded = false;
    constructor(tts, config, manifest, 
    /** The voice used when a call names none. */
    defaultVoice) {
        this.tts = tts;
        this.config = config;
        this.manifest = manifest;
        this.defaultVoice = defaultVoice;
    }
    /**
     * Fetch everything this language needs and get ready to speak.
     *
     * Only the model and its assets are fetched here. The Hebrew g2p, espeak and
     * the voice encoder are each hundreds of megabytes between them and most
     * lines need none of them, so they arrive the first time something asks.
     */
    static async load(options = {}) {
        const config = resolveOptions(options);
        const manifest = await fetchJson(config.baseUrl + "manifest.json");
        const [assets, model] = await Promise.all([
            fetchJson(config.baseUrl + manifest.assets.file),
            fetchAsset(config.baseUrl + manifest.model.file, (progress) => options.onProgress?.("model", progress), manifest.model.sha256),
        ]);
        const tts = await PocketTTS.create(model, assets);
        // The language's own voice, when this really is that language's folder;
        // a caller who pointed `modelsUrl` elsewhere gets whatever is first.
        const preferred = languageByName(options.language ?? "english").voice;
        const voice = manifest.voices.includes(preferred) ? preferred : manifest.voices[0];
        return new Pipeline(tts, config, manifest, voice);
    }
    /** The folder this model came from, settled from the options it was given. */
    get modelsUrl() {
        return this.config.baseUrl;
    }
    get sampleRate() {
        return this.manifest.sampleRate;
    }
    get voices() {
        return this.manifest.voices;
    }
    /** Whether this model carries the adapter that can read phonemes. */
    get hasPhonemes() {
        return this.tts.phonemeTokenizer !== null;
    }
    /** What this model was exported to sample at, which differs per language. */
    get defaults() {
        return {
            temperature: this.tts.config.temperature,
            decodeSteps: this.tts.config.sampler_decode_steps,
        };
    }
    /** The whole utterance, as one mono `Float32Array` at `sampleRate`. */
    async speak(text, options = {}) {
        const frames = [];
        let total = 0;
        for await (const frame of this.stream(text, options)) {
            frames.push(frame);
            total += frame.length;
        }
        const out = new Float32Array(total);
        let at = 0;
        for (const frame of frames) {
            out.set(frame, at);
            at += frame.length;
        }
        return out;
    }
    /** The same audio, 80 ms at a time, as it is decoded. */
    async *stream(text, options = {}) {
        const voice = options.voice ?? this.defaultVoice;
        // The text decides the pipeline: plain English stays on the base model,
        // which reads it better than phonemes; anything with Hebrew or a
        // `[[literal]]` needs the adapter, because only its tokenizer has ids for
        // those characters.
        const phonemes = this.hasPhonemes && (HEBREW.test(text) || LITERAL.test(text));
        const prompt = phonemes
            ? await this.phonemize(text, options)
            : // Every model but the adapted one lacks ids for what a literal holds, so
                // the brackets cannot be honoured there. Take them off anyway: `[[hola]]`
                // on the Spanish model is then simply spoken, rather than read out as
                // punctuation.
                text.replace(LITERAL_BODY, "$1");
        if (options.debug) {
            const { chunks, tokens } = this.tts.inspect(prompt, phonemes);
            options.onDebug?.({
                path: phonemes ? "adapter · phoneme tokenizer" : "base model · sentencepiece",
                prompt,
                chunks,
                tokens: tokens.map((token) => ({ id: token, ...this.tts.describeToken(token) })),
            });
        }
        options.onStatus?.("warming up");
        await this.tts.prepareVoice(voice, phonemes);
        yield* this.tts.stream({
            text: prompt,
            voice,
            phonemes,
            temperature: options.temperature,
            decodeSteps: options.decodeSteps,
            seed: options.seed,
            signal: options.signal,
        });
    }
    /** Turn everyday text into the stressed IPA the adapter reads. */
    async phonemize(text, options) {
        options.onStatus?.("phonemizing");
        const hebrew = HEBREW.test(text) ? await this.hebrew(options.onProgress) : null;
        if (LATIN.test(text))
            await this.english(options.onProgress);
        return phonemizeMixed(text, {
            hebrew: async (part) => (hebrew ? hebrew.phonemize(part) : part),
            latin: async (part) => (this.espeakReady ? phonemizeEnglish(part) : part),
        });
    }
    async hebrew(onProgress) {
        if (!this.g2p) {
            const bytes = await fetchAsset(this.config.baseUrl + "renikud.onnx", (progress) => onProgress?.("g2p", progress));
            this.g2p = await HebrewG2P.create(bytes);
        }
        return this.g2p;
    }
    async english(onProgress) {
        if (this.espeakReady)
            return;
        await loadEspeak(this.config.espeakWasmUrl, (progress) => onProgress?.("espeak", progress));
        this.espeakReady = true;
    }
    /**
     * Encode a recording into conditioning you can pass back as `voice`.
     *
     * Clone whose voice you may: your own, or someone who has said yes. Twenty
     * seconds is as much as the encoder reads; anything past that is dropped.
     */
    async clone(samples, options = {}) {
        if (!this.encoderLoaded) {
            const encoder = this.manifest.encoder;
            if (!encoder)
                throw new Error("this model was exported without a voice encoder");
            const bytes = await fetchAsset(this.config.baseUrl + encoder.file, (progress) => options.onProgress?.("encoder", progress), encoder.sha256);
            await this.tts.loadEncoder(bytes);
            this.encoderLoaded = true;
        }
        return this.tts.cloneVoice(samples);
    }
    /**
     * Warm a voice while nobody is waiting for it.
     *
     * The prompt the voice conditioning becomes is half a second of work, and it
     * is the same half second whether it happens now or on the first take. Doing
     * it when the voice is chosen means the take itself only pays for its text.
     */
    async prepare(voice = this.defaultVoice, phonemes = false) {
        await this.tts.prepareVoice(voice, phonemes);
        if (!phonemes)
            return;
        // The Hebrew path also has to fetch renikud and espeak, and both are slower
        // on the sentence that loads them than on any sentence after; a throwaway
        // word here is what makes the first Hebrew take cost the same as the tenth.
        const hebrew = await this.hebrew();
        await hebrew.phonemize("שלום");
        await this.english();
        if (this.espeakReady)
            await phonemizeEnglish("hello");
    }
    /** How `stream` would split this text, and what its first chunk tokenizes to. */
    inspect(text, phonemes = this.hasPhonemes && HEBREW.test(text)) {
        return this.tts.inspect(text, phonemes);
    }
}
/** Fetch a language's model and get ready to speak it. */
export const load = Pipeline.load;
