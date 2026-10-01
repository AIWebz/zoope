/*
 * Turns on cross-origin isolation for zoope, so the AI engine and the voice can use
 * several CPU threads (SharedArrayBuffer) instead of one. Static hosts can't send the
 * needed headers, so this service worker adds them to zoope's own responses.
 * Cross-origin requests (the model downloads) pass through untouched.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (new URL(r.url).origin !== self.location.origin) return;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(fetch(r).then((res) => {
    if (!res || res.status === 0 || res.type === 'opaque') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
