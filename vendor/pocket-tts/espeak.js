/**
 * English text to phonemes, from espeak-ng compiled to wasm.
 *
 * The Hebrew adapter reads phonemes, so a Latin word sitting inside a Hebrew
 * sentence needs the same treatment the Hebrew does. espeak is 18 MB, which is
 * why it is fetched only when a line actually mixes the two — someone writing
 * plain Hebrew never pays for it.
 */
import { defaultEspeakWasm } from "./platform.web.js";
import { fetchAsset } from "./assets.js";
// espeak's --ipa=3 joins the halves of a diphthong with a zero-width joiner.
const TIE = /‍/g;
// It also drops punctuation, so the text is split around it and put back after.
const PUNCTUATION = /([,.!?;:—–-]+)/;
let binary = null;
let factory = null;
/**
 * `url` is where the wasm comes from: a file in node_modules under Node, a
 * pinned CDN copy in a page, or whatever `espeakWasmUrl` was set to.
 */
export async function loadEspeak(url, onProgress) {
    if (binary && factory)
        return;
    const [bytes, module] = await Promise.all([
        fetchAsset(url ?? defaultEspeakWasm(), onProgress, "espeak-ng-1.0.2"),
        import("espeak-ng"),
    ]);
    binary = bytes;
    factory = (module.default ?? module);
}
export function espeakReady() {
    return binary !== null && factory !== null;
}
async function run(text, language) {
    if (!binary || !factory)
        throw new Error("espeak has not been loaded");
    const espeak = await factory({
        // A leading dash would be read as a flag rather than as text.
        arguments: [
            "--phonout",
            "out.txt",
            "--sep=",
            "-q",
            "-b=1",
            "--ipa=3",
            "-v",
            language,
            text.startsWith("-") ? ` ${text}` : text,
        ],
        wasmBinary: binary,
        print: () => { },
        printErr: () => { },
    });
    return espeak.FS.readFile("out.txt", { encoding: "utf8" })
        .replace(TIE, "")
        .replace(/\s+/g, " ")
        .trim();
}
/** Stressed IPA for `text`, with its punctuation kept. */
export async function phonemizeEnglish(text, language = "en-us") {
    const parts = text.split(PUNCTUATION);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "")
            continue;
        // Odd indices are the punctuation the split captured; keep them verbatim.
        if (i % 2 === 1 || !/\p{L}/u.test(part)) {
            out.push(part);
            continue;
        }
        const lead = part.slice(0, part.length - part.trimStart().length);
        const trail = part.slice(part.trimEnd().length);
        out.push(lead + (await run(part.trim(), language)) + trail);
    }
    return out.join("");
}
