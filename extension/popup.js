/* zoope extension popup: the Connect button that installs and starts the AI engine. */
const $ = (id) => document.getElementById(id);
function show(st) {
  const s = st || {}, btn = $('connect'), status = $('status');
  status.className = '';
  $('bar').style.width = Math.round((s.state === 'ready' ? 1 : s.progress || 0) * 100) + '%';
  if (s.state === 'ready') {
    btn.textContent = 'Connected'; btn.disabled = true;
    status.textContent = 'AI engine installed and running (' + (s.device === 'webgpu' ? 'GPU' : 'CPU') + '). zoope uses it for its replies.';
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
function refresh() { chrome.runtime.sendMessage({ type: 'aiStatus' }).then(show).catch(() => {}); }
$('connect').addEventListener('click', () => {
  show({ state: 'loading' });
  chrome.runtime.sendMessage({ type: 'aiConnect' }).then(show).catch((e) => show({ state: 'error', error: e.message }));
});
refresh();
setInterval(refresh, 500);
