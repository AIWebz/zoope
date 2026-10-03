/* zoope extension popup: the Connect button that installs and starts the AI engine. */
const $ = (id) => document.getElementById(id);
function show(st) {
  const s = st || {}, btn = $('connect'), status = $('status');
  status.className = '';
  $('bar').style.width = Math.round((s.state === 'ready' ? 1 : s.progress || 0) * 100) + '%';
  if (s.state === 'ready') {
    btn.textContent = 'Connected'; btn.disabled = true;
    status.textContent = s.device === 'chrome-ai' ? 'Running Chrome\'s built-in AI (Gemini Nano). zoope uses it for its replies.'
      : 'Running zoope\'s own AI model (' + (s.device === 'webgpu' ? 'GPU' : 'CPU') + '). zoope uses it for its replies.';
    status.className = 'ok';
  } else if (s.state === 'loading') {
    btn.textContent = 'Connecting…'; btn.disabled = true;
    status.textContent = (s.progress ? 'Downloading the AI model: ' + Math.round(s.progress * 100) + '%' : 'Starting the AI engine…') + ' (first time only)';
  } else if (s.state === 'error') {
    btn.textContent = 'Try again'; btn.disabled = false;
    status.textContent = 'Couldn\'t install the AI engine: ' + (s.error || 'unknown error');
    status.className = 'err';
  } else {
    btn.textContent = 'Connect'; btn.disabled = false;
    status.textContent = 'Not connected.';
  }
}
function refresh() {
  chrome.runtime.sendMessage({ type: 'aiStatus' }).then((st) => {
    show(st);
    if (nanoMsg && st.device !== 'chrome-ai') $('status').textContent = nanoMsg + (st.state === 'ready' ? ' (zoope\'s own model is used until it finishes)' : '');
  }).catch(() => {});
}
let nanoMsg = '';
$('connect').addEventListener('click', async () => {
  show({ state: 'loading' });
  // Chrome's built-in AI may need its model downloaded first; that needs this click
  try {
    const st = await self.ZoopeNano.status();
    if (st === 'downloadable' || st === 'downloading') {
      nanoMsg = 'Chrome is downloading its built-in AI…';
      self.ZoopeNano.download((p) => { nanoMsg = 'Chrome is downloading its built-in AI: ' + Math.round(p * 100) + '%'; })
        .then(() => { nanoMsg = ''; chrome.runtime.sendMessage({ type: 'aiStatus' }).then(show); })
        .catch(() => { nanoMsg = ''; });
    }
  } catch (e) { /* no built-in AI: zoope's own model is used */ }
  chrome.runtime.sendMessage({ type: 'aiConnect' }).then(show).catch((e) => show({ state: 'error', error: e.message }));
});
refresh();
setInterval(refresh, 500);
