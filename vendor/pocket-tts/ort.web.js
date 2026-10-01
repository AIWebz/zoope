/**
 * onnxruntime for the browser.
 *
 * Which of `ort.web.ts` and `ort.node.ts` a build gets is decided by the
 * `#ort` entry in package.json, not by anything here: bundlers and browsers
 * land on this one, Node lands on the native binding next door. Everything
 * else in the package imports `#ort` and never names a runtime, so the same
 * source runs in both places.
 */
export * from "../onnxruntime/ort.wasm.min.mjs";
