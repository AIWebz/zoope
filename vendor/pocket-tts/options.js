/**
 * What a caller may say, and what the rest of the package reads.
 *
 * Everything environment-shaped is settled here and nowhere else, so no module
 * further in has to know whether it is running in a page or in a script, or
 * reach for a bundler's `import.meta.env`. Every field has a default that
 * works, which is what makes `await load()` a complete program.
 */
import { configureRuntime } from "./platform.web.js";
import { language as languageByName } from "./languages.js";
/**
 * Where the published models live.
 *
 * Hugging Face rather than the GitHub release: release assets are served
 * without CORS headers, so a browser cannot fetch them at all. Each language
 * is a folder of its own underneath.
 */
export const MODELS_URL = "https://huggingface.co/thewh1teagle/pocket-tts-onnx/resolve/main/";
const slash = (url) => (url.endsWith("/") ? url : `${url}/`);
/** Settle a caller's options, and tell onnxruntime what it needs to know. */
export function resolveOptions(options = {}) {
    configureRuntime({ ortWasmUrl: options.ortWasmUrl, threads: options.threads });
    // `||`, not `??`: an unset environment variable reaches a build as an empty
    // string, which would otherwise be taken as a real base and 404.
    const base = options.modelsUrl || MODELS_URL + languageByName(options.language ?? "english").model;
    return { baseUrl: slash(base), espeakWasmUrl: options.espeakWasmUrl };
}
