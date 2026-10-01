/*
 * zoope extension: bridge on the zoope site.
 *
 * Lets the zoope page talk to the extension with window.postMessage:
 * the page posts { zoopeApp: { id, ... } } and gets { zoopeExt: { id, reply } };
 * messages from the meeting arrive as { zoopeExt: { event } }.
 */
(() => {
  const version = chrome.runtime.getManifest().version;
  const announce = () => {
    document.documentElement.dataset.zoopeExtension = version;
    window.postMessage({ zoopeExt: { hello: version } }, location.origin);
  };
  announce();
  document.addEventListener('DOMContentLoaded', announce);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.zoopeApp) return;
    const req = e.data.zoopeApp;
    if (req.type === 'hello') { announce(); return; }
    chrome.runtime.sendMessage(req.msg).then((reply) => {
      window.postMessage({ zoopeExt: { id: req.id, reply } }, location.origin);
    }).catch((err) => {
      window.postMessage({ zoopeExt: { id: req.id, reply: { ok: false, error: String(err && err.message || err) } } }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    window.postMessage({ zoopeExt: { event: msg } }, location.origin);
  });
})();
