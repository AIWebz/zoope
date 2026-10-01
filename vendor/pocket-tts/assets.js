/**
 * Fetching the model, with progress, and keeping it between runs.
 *
 * The weights are the whole cost of this package, so the download is streamed
 * for a real progress bar and then parked wherever this environment keeps
 * things — the Cache API in a page, a directory under `~/.cache` in Node. A
 * second run pays no network at all.
 */
import { cacheGet, cachePut, cacheClear, readLocal } from "./platform.web.js";
/**
 * The cache key for an asset: its digest, when the manifest gives one.
 *
 * Only the key carries the digest; the fetch itself uses the plain URL. Keyed
 * by digest rather than by URL, the same bytes published under two folders,
 * as `en/` and `he/` are, cost one download, and a changed model under the
 * same name simply misses. The Cache API wants a URL for a key, and compares
 * query strings but drops fragments, so the digest rides in `?v=` on the
 * file's name alone.
 */
const keyFor = (url, version) => version ? `${url.slice(url.lastIndexOf("/") + 1)}?v=${version}` : url;
/** Whether this exact asset is already cached, without fetching it. */
export async function isCached(url, version) {
    return (await cacheGet(keyFor(url, version))) !== null;
}
/**
 * Fetch an asset, and keep it under a key that changes when it does.
 *
 * The URL alone is not a safe cache key: a new model published to the same
 * filename would be masked by the old one forever. The manifest carries a
 * digest per file, so that goes in the key and a changed model simply misses.
 */
export async function fetchAsset(url, onProgress, version) {
    // A local path is already on the disk it would be cached to.
    const local = await readLocal(url);
    if (local) {
        onProgress?.({ loaded: local.byteLength, total: local.byteLength, cached: true });
        return local;
    }
    const key = keyFor(url, version);
    const hit = await cacheGet(key);
    if (hit) {
        // Say it is a cache hit before reading the body, not after. Waiting until
        // the bytes land would leave a caller claiming to be downloading for the
        // whole of it.
        onProgress?.({ loaded: 0, total: hit.size, cached: true });
        const bytes = await hit.bytes();
        onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, cached: true });
        return bytes;
    }
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${response.status} fetching ${url}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const body = response.body;
    if (!body)
        return response.arrayBuffer();
    const chunks = [];
    let loaded = 0;
    const reader = body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({ loaded, total, cached: false });
    }
    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }
    await cachePut(key, bytes.buffer);
    return bytes.buffer;
}
export async function fetchJson(url) {
    const local = await readLocal(url);
    if (local)
        return JSON.parse(new TextDecoder().decode(local));
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${response.status} fetching ${url}`);
    return (await response.json());
}
/** Drop every cached model. */
export const clearAssetCache = cacheClear;
