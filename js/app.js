/* zoope app: wires the UI to the on-device engine, avatar and voice modules. */
(function () {
  'use strict';

  var PLATFORMS = {
    zoom: { name: 'Zoom', img: 'assets/zoom.jpg' },
    meet: { name: 'Google Meet', img: 'assets/meet.png' },
    teams: { name: 'Microsoft Teams', img: 'assets/teams.webp' }
  };

  var SAMPLE_KNOWLEDGE = 'The website redesign is 80% done and launches on October 14. ' +
    'I am working on the checkout page this week. Budget questions should go to Priya. ' +
    'I prefer Tuesday afternoons for design reviews.';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, cls) { return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }

  /* ------------------------------ storage ------------------------------ */
  var state = load();
  function load() {
    var def = { platforms: {}, profile: { fullName: '', names: [], preferred: '', knowledge: '', notes: [] }, face: null, voice: null, meetings: [], summaries: [], chatStep: 'name' };
    try {
      var raw = localStorage.getItem('zoope');
      if (raw) {
        var s = JSON.parse(raw);
        for (var k in def) if (!(k in s)) s[k] = def[k];
        if (!s.profile.notes) s.profile.notes = [];
        // older versions kept one block of "knowledge"; it becomes a background note
        if (s.profile.knowledge && !s.profile.notes.length) {
          s.profile.notes.push({ id: 'n' + Date.now().toString(36), kind: 'info', text: s.profile.knowledge, created: Date.now() });
          s.profile.knowledge = '';
        }
        return s;
      }
    } catch (e) { /* storage unavailable */ }
    return def;
  }
  function save() {
    try { localStorage.setItem('zoope', JSON.stringify(state)); } catch (e) { /* ignore */ }
    renderChecklist();
  }

  /* ---------------------------- toasts + dialog ---------------------------- */
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.innerHTML = icon(kind === 'error' ? 'stop' : 'check') + '<span>' + esc(msg) + '</span>';
    $('toasts').appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 220); }, 3200);
  }

  var dialogResolve = null;
  function confirmDialog(opts) {
    $('dialogTitle').textContent = opts.title;
    $('dialogBody').innerHTML = opts.body;
    $('dialogOk').textContent = opts.ok || 'Confirm';
    $('dialogOk').className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    $('dialog').classList.remove('hidden');
    setTimeout(function () { $('dialogOk').focus(); }, 30);
    return new Promise(function (resolve) { dialogResolve = resolve; });
  }
  function closeDialog(result) {
    $('dialog').classList.add('hidden');
    if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
  }
  $('dialogOk').addEventListener('click', function () { closeDialog(true); });
  $('dialogCancel').addEventListener('click', function () { closeDialog(false); });
  $('dialog').addEventListener('click', function (e) { if (e.target === $('dialog')) closeDialog(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialogResolve) closeDialog(false); });

  /* ----------------------------- connections ----------------------------- */
  function renderPlatforms() {
    document.querySelectorAll('.platform').forEach(function (el) {
      var key = el.dataset.platform, acct = state.platforms[key];
      var input = el.querySelector('.acct'), btn = el.querySelector('.connect-btn');
      el.classList.toggle('connected', !!acct);
      el.querySelector('.platform-sub').textContent = acct || 'Not linked';
      input.disabled = !!acct;
      if (acct) input.value = acct;
      btn.textContent = acct ? 'Unlink' : 'Link';
      btn.className = 'btn connect-btn ' + (acct ? 'btn-ghost' : 'btn-secondary');
    });
    var sel = $('mPlatform'), cur = sel.value;
    sel.innerHTML = Object.keys(PLATFORMS).map(function (k) {
      return '<option value="' + k + '"' + (state.platforms[k] ? '' : ' disabled') + '>' + PLATFORMS[k].name + (state.platforms[k] ? '' : ' (not linked)') + '</option>';
    }).join('');
    var firstOk = Object.keys(PLATFORMS).filter(function (k) { return state.platforms[k]; })[0];
    sel.value = state.platforms[cur] ? cur : (firstOk || 'zoom');
  }

  document.querySelectorAll('.platform').forEach(function (el) {
    var input = el.querySelector('.acct');
    function toggle() {
      var key = el.dataset.platform;
      if (state.platforms[key]) {
        delete state.platforms[key];
        toast(PLATFORMS[key].name + ' account removed');
      } else {
        var v = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { input.classList.add('invalid'); input.focus(); return; }
        input.classList.remove('invalid');
        state.platforms[key] = v;
        toast(PLATFORMS[key].name + ' account saved');
      }
      save(); renderPlatforms();
    }
    el.querySelector('.connect-btn').addEventListener('click', toggle);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') toggle(); });
    input.addEventListener('input', function () { input.classList.remove('invalid'); });
  });

  /* ------------------------------ names chat ------------------------------ */
  var chat = $('setupChat');
  function bot(text) { addMsg('bot', text); }
  function me(text) { addMsg('me', text); }
  function addMsg(cls, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = (cls === 'bot' ? '<span class="msg-avatar">z</span>' : '') + '<div class="msg-body">' + esc(text) + '</div>';
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
  }
  function splitNames(s) {
    return s.split(/,|\bor\b|\band\b|\//i).map(function (n) { return n.trim().replace(/^["']|["'.!]$/g, ''); })
      .filter(function (n) { return n && n.length <= 30; });
  }
  function addNames(list) {
    list.forEach(function (n) {
      if (!state.profile.names.some(function (x) { return x.toLowerCase() === n.toLowerCase(); })) state.profile.names.push(n);
    });
  }
  function renderChips() {
    var p = state.profile;
    $('nameChips').innerHTML = p.names.length ? '<span class="chips-label">Responds to</span>' + p.names.map(function (n, i) {
      var pref = n === p.preferred;
      return '<span class="chip' + (pref ? ' preferred' : '') + '"' + (pref ? ' title="Introduces itself with this name"' : '') + '>' +
        (pref ? '★ ' : '') + esc(n) + '<button type="button" data-i="' + i + '" aria-label="Remove ' + esc(n) + '">×</button></span>';
    }).join('') : '';
  }
  $('nameChips').addEventListener('click', function (e) {
    var i = e.target.dataset.i;
    if (i == null) return;
    var removed = state.profile.names.splice(+i, 1)[0];
    if (removed === state.profile.preferred) state.profile.preferred = state.profile.names[0] || '';
    save(); renderChips();
  });

  var ASK = {
    name: function () { bot('Hi, I\'m zoope. I\'ll attend meetings as you. First, what\'s your full name?'); },
    nicknames: function () {
      bot('Nice to meet you, ' + state.profile.fullName.split(' ')[0] + '. What names do people call you by? Include nicknames, short names or initials, separated by commas.');
    },
    preferred: function () { bot('Got it: ' + state.profile.names.join(', ') + '. Which one should I introduce myself with?'); },
    more: function () { bot('Any other names people use for you, like a work nickname? Type "no" if that\'s all.'); },
    done: function () {
      bot('All set. I\'ll answer to ' + state.profile.names.join(', ') + ' and introduce myself as ' + state.profile.preferred + '. Type "change" to start over.');
    }
  };

  function handleChat(text) {
    var p = state.profile, step = state.chatStep;
    me(text);
    if (/^change\b/i.test(text)) {
      p.names = []; p.preferred = ''; state.chatStep = 'name';
      save(); renderChips(); setTimeout(ASK.name, 300); return;
    }
    if (step === 'name') {
      p.fullName = text.replace(/^(i'?m|my name is|it'?s)\s+/i, '').trim();
      addNames([p.fullName.split(' ')[0]]);
      state.chatStep = 'nicknames';
    } else if (step === 'nicknames') {
      if (!/^(none|no|nothing|just that)$/i.test(text)) addNames(splitNames(text));
      state.chatStep = p.names.length > 1 ? 'preferred' : 'more';
      if (p.names.length === 1) p.preferred = p.names[0];
    } else if (step === 'preferred') {
      var choice = splitNames(text)[0] || p.names[0];
      addNames([choice]);
      p.preferred = choice;
      state.chatStep = 'more';
    } else if (step === 'more') {
      if (/^(no|nope|none|that'?s (all|it)|done)\b/i.test(text)) {
        state.chatStep = 'done';
      } else {
        addNames(splitNames(text));
        save(); renderChips();
        setTimeout(function () { bot('Added. Anything else?'); }, 300);
        return;
      }
    } else {
      setTimeout(function () { bot('Your names are saved. Type "change" to redo them.'); }, 300);
      return;
    }
    save(); renderChips();
    setTimeout(ASK[state.chatStep], 350);
  }

  $('setupForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('setupInput').value.trim();
    if (!v) return;
    $('setupInput').value = '';
    handleChat(v);
  });

  function startChat() {
    if (state.chatStep === 'done') {
      ASK.done();
    } else {
      if (state.chatStep !== 'name' && !state.profile.fullName) state.chatStep = 'name';
      ASK[state.chatStep]();
    }
  }

  /* -------------------------------- notes -------------------------------- */
  function relTime(t) {
    var d = Date.now() - t, m = Math.round(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderNotes() {
    var notes = state.profile.notes || [];
    var pending = notes.filter(function (n) { return n.kind === 'share'; }).length;
    $('noteCountPill').textContent = notes.length;
    $('navNoteCount').textContent = pending || '';
    $('notesTeaser').textContent = notes.length
      ? notes.length + ' note' + (notes.length === 1 ? '' : 's') + (pending ? ', ' + pending + ' to bring up in your next meeting' : '') + '.'
      : 'No notes yet.';
    if (!notes.length) {
      $('noteList').innerHTML = '<div class="empty"><div class="empty-icon">' + icon('note') + '</div><h3>No notes yet</h3>' +
        '<p>Send zoope what it should know, like a status update, or something to tell the team.</p></div>';
      return;
    }
    $('noteList').innerHTML = notes.slice().sort(function (x, y) { return y.created - x.created; }).map(function (n) {
      var pill = n.kind === 'share' ? '<span class="pill pill-accent pill-dot">Next meeting</span>'
        : n.kind === 'shared' ? '<span class="pill pill-green pill-dot">Shared</span>' : '<span class="pill">Background</span>';
      var meta = n.kind === 'shared' ? 'Said in ' + esc(n.sharedIn || 'a meeting') + ', ' + relTime(n.sharedAt) : 'Sent ' + relTime(n.created);
      if (n.kind === 'share') meta += ' · zoope will bring this up';
      return '<div class="note-row" data-id="' + n.id + '">' + pill + '<div><p>' + esc(n.text) + '</p><small>' + meta + '</small></div>' +
        '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-del="' + n.id + '" aria-label="Delete note" title="Delete">' + icon('trash') + '</button></div>';
    }).join('');
  }

  $('noteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('noteText').value.trim();
    if (!text) return;
    var kind = document.querySelector('input[name="noteKind"]:checked').value;
    state.profile.notes.push({ id: 'n' + Date.now().toString(36), kind: kind, text: text, created: Date.now() });
    save();
    $('noteText').value = '';
    renderNotes();
    toast(kind === 'share' ? 'Sent. zoope will bring it up in your next meeting.' : 'Sent. zoope will use it when asked.');
  });
  $('noteText').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('noteForm').requestSubmit();
  });
  $('noteList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]');
    if (!b) return;
    state.profile.notes = state.profile.notes.filter(function (n) { return n.id !== b.dataset.del; });
    save(); renderNotes();
  });

  /* ---------------------------- face + voice scan ---------------------------- */
  var stream = null, stopPreview = null, previewLevel = 0;
  var cam = $('cam');

  function setStartCamLabel(on) {
    $('startCam').querySelector('span').textContent = on ? 'Camera & mic on' : 'Enable camera & mic';
    $('startCam').className = 'btn ' + (on ? 'btn-secondary' : 'btn-primary');
    $('startCam').disabled = on;
  }

  function refreshAvatarBox() {
    if (stopPreview) stopPreview();
    stopPreview = null;
    var live = state.face && state.face.kind === 'mesh' && !!state.face.portrait;
    $('avatarInfo').textContent = !state.face ? 'None yet' : live ? 'Building live avatar…' : state.face.kind === 'mesh' ? 'Rescan for the live avatar' : 'Illustrated';
    $('avatarMeasured').textContent = '–';
    if (state.face) {
      stopPreview = ZoopeAvatar.animate($('avatarCanvas'), state.face, function () { return previewLevel; }, {
        frame: 'head',
        onReady: function (info) {
          $('avatarInfo').textContent = 'Live · ' + info.width + '×' + info.height;
          $('avatarMeasured').textContent = info.vertices + ' points';
        },
        on3DError: function () { $('avatarInfo').textContent = '2D (WebGL unavailable)'; }
      });
    } else {
      ZoopeAvatar.draw($('avatarCanvas'), null);
    }
    $('testVoice').disabled = !state.face;
    renderScanSteps();
  }

  /* ------------------------------ head scan steps ------------------------------ */
  var SCAN_STEPS = [
    { key: 'front', title: 'Face & hair', button: 'Capture', countdown: 3,
      text: 'Face the camera with your head, hair and shoulders in view, in good light. Keep a neutral expression with your mouth closed.' }
  ];
  var scanStep = 0, scanning = false;

  function stepDone(i) {
    var f = state.face;
    return !!(f && f.portrait && i === 0);
  }
  function scanCount() { var n = 0; for (var i = 0; i < SCAN_STEPS.length; i++) if (stepDone(i)) n++; return n; }
  function firstMissing() { for (var i = 0; i < SCAN_STEPS.length; i++) if (!stepDone(i)) return i; return -1; }

  function renderScanSteps() {
    var f = state.face;
    document.querySelectorAll('#scanSteps li').forEach(function (li, i) {
      li.classList.toggle('done', stepDone(i));
      li.classList.toggle('current', i === scanStep);
      var photo = f && f.portrait && f.photo;
      li.querySelector('.ss-thumb').style.backgroundImage = photo ? 'url(' + photo + ')' : '';
      li.querySelector('em').textContent = stepDone(i) ? 'Captured' : 'Front';
    });
    var st = SCAN_STEPS[scanStep];
    $('scanTitle').textContent = st.title;
    $('scanInstruction').textContent = st.text;
    $('scanFace').querySelector('span').textContent = stepDone(scanStep) ? 'Rescan' : st.button;
    $('scanGuide').dataset.step = scanStep;
    var n = scanCount();
    $('faceBadge').textContent = n ? 'Captured' : 'Not scanned';
    $('faceBadge').className = 'pill ' + (n ? 'pill-green pill-dot' : '');
  }

  document.querySelectorAll('#scanSteps li').forEach(function (li, i) {
    li.querySelector('button').addEventListener('click', function () {
      if (scanning) return;
      if (i > 0 && !stepDone(0)) { toast('Start with step 1, the front of your face.', 'error'); return; }
      scanStep = i;
      renderScanSteps();
      $('scanStatus').textContent = stream ? 'Press the button when you\'re in position.' : 'Enable the camera to start the scan.';
    });
  });

  // short beeps for the countdown, so the user can follow it while facing away
  function beep(freq, ms) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext, ac = new AC(), o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq; g.gain.value = 0.08;
      o.connect(g); g.connect(ac.destination); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + ms / 1000);
      o.stop(ac.currentTime + ms / 1000 + 0.02);
      o.onended = function () { ac.close(); };
    } catch (e) { /* no audio */ }
  }
  function countdown(seconds) {
    return new Promise(function (resolve) {
      var left = seconds, el = $('scanCount');
      el.classList.remove('hidden');
      (function tick() {
        el.textContent = left;
        if (left === 0) { beep(1320, 220); el.classList.add('hidden'); return resolve(); }
        beep(880, 120);
        left--;
        setTimeout(tick, 1000);
      })();
    });
  }

  $('startCam').addEventListener('click', function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This browser can\'t access a camera.', 'error'); return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: true }).then(function (s) {
      stream = s;
      cam.srcObject = s;
      cam.play();
      $('camPlaceholder').classList.add('hidden');
      ['scanFace', 'recordVoice'].forEach(function (id) { $(id).disabled = false; });
      $('scanVoiceStatus').textContent = 'Ready. Press “Scan my voice” and read the passage.';
      setStartCamLabel(true);
      $('scanStatus').textContent = 'Press the button when you\'re in position.';
    }).catch(function (err) {
      toast('Couldn\'t open the camera or mic: ' + err.message, 'error');
    });
  });

  // Turns the camera and mic off (used when leaving the page).
  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    cam.srcObject = null;
    $('camPlaceholder').classList.remove('hidden');
    setStartCamLabel(false);
    ['scanFace', 'recordVoice'].forEach(function (id) { $(id).disabled = true; });
  }

  $('scanFace').addEventListener('click', function () {
    if (!stream || scanning) return;
    var step = scanStep, st = SCAN_STEPS[step], line = $('scanLine');
    scanning = true;
    $('scanFace').disabled = true;
    $('scanStatus').textContent = 'Loading the scanning models…';
    Promise.all([ZoopeFaceMesh.load(), ZoopeFaceMesh.loadSegmenter()]).then(function () {
      $('scanStatus').textContent = 'Get into position. Capturing after the countdown.';
      return countdown(st.countdown);
    }).then(function () {
      line.classList.add('on');
      $('scanStatus').textContent = 'Scanning…';
      return ZoopeHeadScan.captureFront(cam);
    }).then(function (res) {
      if (!res.ok) { beep(220, 300); $('scanStatus').textContent = res.reason; return; }
      state.face = res.face;
      save();
      refreshAvatarBox();
      $('scanStatus').textContent = 'Captured. Your live avatar is ready. It moves, blinks and speaks with your face.';
      toast('Face captured');
    }).catch(function () {
      // the scanning models couldn't load: fall back to an illustrated avatar, and say so
      state.face = ZoopeAvatar.scanFace(cam);
      save();
      refreshAvatarBox();
      $('scanStatus').textContent = 'The scanning models couldn\'t load, so zoope made an illustrated avatar instead. This is not a 3D scan.';
    }).then(function () {
      line.classList.remove('on');
      scanning = false;
      $('scanFace').disabled = !stream;
    });
  });

  /* ------------------------------ voice ------------------------------ */
  var SAMPLE_SECONDS = 15, SAMPLE_RATE = 24000;
  var voiceSample = loadSample(), neuralModule = null, neuralState = 'none'; // none | loading | ready | error
  try { localStorage.removeItem('zoope-voiceclone'); } catch (e) { /* old alphabet recordings are no longer used */ }

  function loadSample() {
    try {
      var raw = JSON.parse(localStorage.getItem('zoope-voicesample') || 'null');
      return raw ? { rate: raw.rate, data: ZoopeVoice.decodePCM(raw.pcm) } : null;
    } catch (e) { return null; }
  }
  function saveSample() {
    try {
      localStorage.setItem('zoope-voicesample', JSON.stringify({ rate: voiceSample.rate, pcm: ZoopeVoice.encodePCM(voiceSample.data) }));
      return true;
    } catch (e) { return false; }
  }

  function neural() {
    if (!neuralModule) {
      neuralModule = import(new URL('js/neuralvoice.js', document.baseURI).href);
      neuralModule.catch(function () { neuralModule = null; });
    }
    return neuralModule;
  }

  // the voice profile measured from the scan
  function renderProfile() {
    var v = state.voice;
    var has = !!(v && v.ok && v.contour);
    $('voiceProfile').classList.toggle('hidden', !has);
    if (!has) return;
    $('vpPitch').innerHTML = v.pitchHz + ' Hz<small>' + (v.pitchHz < 125 ? 'low' : v.pitchHz < 180 ? 'medium-low' : v.pitchHz < 230 ? 'medium-high' : 'high') + '</small>';
    $('vpRange').innerHTML = v.rangeSemitones + ' st<small>' + v.lowHz + '–' + v.highHz + ' Hz</small>';
    $('vpPace').innerHTML = v.pace + '<small>syllables/s</small>';
    $('vpBright').innerHTML = v.brightnessHz + ' Hz<small>' + (v.brightnessHz < 900 ? 'warm' : v.brightnessHz < 1500 ? 'balanced' : 'bright') + '</small>';
    var c = $('vpCanvas'), ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    var pts = v.contour, lo = v.lowHz * 0.85, hi = v.highHz * 1.15;
    ctx.strokeStyle = '#e4e4e7'; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (f) { ctx.beginPath(); ctx.moveTo(0, H * f); ctx.lineTo(W, H * f); ctx.stroke(); });
    ctx.fillStyle = '#0b5cff';
    pts.forEach(function (hz, i) {
      if (!hz) return;
      var x = i / (pts.length - 1) * W, y = H - (Math.log(hz / lo) / Math.log(hi / lo)) * H;
      ctx.fillRect(x - 1.5, Math.max(0, Math.min(H - 3, y - 1.5)), 3, 3);
    });
  }

  // Phones give a browser tab far less memory than the voice model needs (~1 GB while it
  // loads), and reset the tab instead of reporting an error, so the model never runs there.
  var IS_PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  var PHONE_VOICE_MSG = 'On a phone, zoope makes your light voice: a small speech synthesizer (18 MB) tuned to your pitch, pace and tone from this scan. It works on every phone. The HD neural clone needs a computer.';
  function renderVoice(msg) {
    var badge = $('neuralBadge');
    var labels = { none: voiceSample ? 'Scanned' : 'Not scanned', loading: 'Making your voice…', ready: 'Your voice is ready', error: 'Browser voice (fallback)' };
    var liteOn = neuralState !== 'ready' && neuralState !== 'loading' && liteReady();
    badge.textContent = liteOn ? 'Light voice ready' : labels[neuralState];
    badge.className = 'pill ' + (neuralState === 'ready' || liteOn ? 'pill-green pill-dot' : neuralState === 'error' ? 'pill-amber' : voiceSample ? 'pill-accent' : '');
    $('buildNeural').disabled = !voiceSample || neuralState === 'loading';
    $('testNeural').classList.toggle('hidden', false);
    if (IS_PHONE && voiceSample && !liteOn && neuralState === 'none' && !msg) msg = PHONE_VOICE_MSG;
    $('testNeural').disabled = neuralState !== 'ready' && neuralState !== 'error' && !liteOn;
    $('testNeural').lastChild.textContent = neuralState === 'error' ? 'Hear fallback voice' : 'Hear my voice';
    $('playSample').disabled = !voiceSample;
    document.querySelectorAll('.vstep')[0].classList.toggle('done', !!voiceSample);
    document.querySelectorAll('.vstep')[1].classList.toggle('done', neuralState === 'ready' || liteOn);
    if (msg) $('neuralStatus').textContent = msg;
    renderChecklist();
  }

  function showProgress(frac, label) {
    $('neuralProgress').classList.remove('hidden');
    $('neuralBar').style.width = Math.round(frac * 100) + '%';
    $('neuralPct').textContent = Math.round(frac * 100) + '%';
    if (label) $('neuralStatus').textContent = label + '…';
  }

  // Records raw microphone audio for `seconds`, resampled to SAMPLE_RATE.
  function recordRaw(s, seconds, onTick) {
    return new Promise(function (resolve, reject) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return reject(new Error('Web Audio is not supported in this browser.'));
      var ac = new AC(), src = ac.createMediaStreamSource(s), proc = ac.createScriptProcessor(4096, 1, 1), mute = ac.createGain();
      // mobile browsers start audio suspended until resumed from the tap that started recording
      if (ac.resume) ac.resume();
      mute.gain.value = 0;
      src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
      var chunks = [], got = 0, need = seconds * ac.sampleRate, finished = false;
      // if no audio arrives (microphone blocked or busy), stop instead of hanging
      var watchdog = setTimeout(function () {
        if (got > 0 || finished) return;
        finished = true;
        try { src.disconnect(); proc.disconnect(); ac.close(); } catch (e) { /* already closed */ }
        reject(new Error('No sound from the microphone. Check that zoope can use it, then try again.'));
      }, 4000);
      proc.onaudioprocess = function (e) {
        if (finished) return;
        var buf = new Float32Array(e.inputBuffer.getChannelData(0));
        chunks.push(buf); got += buf.length;
        var rms = 0; for (var i = 0; i < buf.length; i += 4) rms += buf[i] * buf[i];
        if (onTick) onTick(got / need, Math.min(1, Math.sqrt(rms / (buf.length / 4)) * 8));
        if (got >= need) {
          finished = true; clearTimeout(watchdog);
          src.disconnect(); proc.disconnect();
          var rate = ac.sampleRate; ac.close();
          var all = new Float32Array(got), off = 0;
          chunks.forEach(function (c) { all.set(c, off); off += c.length; });
          resolve(resampleTo(all, rate, SAMPLE_RATE));
        }
      };
    });
  }
  function resampleTo(d, from, to) {
    if (from === to) return d;
    var ratio = from / to, n = Math.floor(d.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = i * ratio, i0 = Math.floor(x), f = x - i0; out[i] = d[i0] * (1 - f) + (d[i0 + 1] || 0) * f; }
    return out;
  }

  // Step 1: record and measure the user's voice
  $('recordVoice').addEventListener('click', function () {
    if (!stream) return;
    var btn = $('recordVoice'), label = btn.querySelector('span');
    btn.disabled = true;
    $('scanVoiceStatus').textContent = 'Recording. Read the passage aloud.';
    recordRaw(stream, SAMPLE_SECONDS, function (frac, level) {
      label.textContent = 'Recording… ' + Math.max(0, Math.ceil(SAMPLE_SECONDS * (1 - frac))) + 's';
      $('sampleMeter').style.width = (level * 100) + '%';
    }).then(function (data) {
      $('sampleMeter').style.width = '0%';
      $('scanVoiceStatus').textContent = 'Analysing your voice…';
      var profile = ZoopeVoice.analyzeSamples(data, SAMPLE_RATE);
      if (!profile.ok) { $('scanVoiceStatus').textContent = profile.reason; toast('Voice scan failed. Try again.', 'error'); return; }
      voiceSample = { rate: SAMPLE_RATE, data: data };
      state.voice = profile;
      state.neuralReady = false;
      state.liteVoice = null;
      neuralState = 'none';
      if (!saveSample()) toast('Browser storage is full, so the recording lasts only until you close this tab.', 'error');
      save();
      renderProfile();
      $('scanVoiceStatus').textContent = 'Voice scanned: ' + profile.voicedSeconds + ' seconds of clear speech measured.';
      renderVoice(IS_PHONE ? PHONE_VOICE_MSG : 'Next, make your voice from this recording.');
      neural().then(function (m) { m.forget(); }).catch(function () {});
      toast('Voice scanned');
    }).catch(function (err) { toast(err.message, 'error'); })
      .then(function () { btn.disabled = !stream; label.textContent = voiceSample ? 'Scan again (15s)' : 'Scan my voice (15s)'; });
  });

  $('playSample').addEventListener('click', function () {
    if (!voiceSample) return;
    var AC = window.AudioContext || window.webkitAudioContext, ac = new AC();
    var buf = ac.createBuffer(1, voiceSample.data.length, voiceSample.rate);
    buf.getChannelData(0).set(voiceSample.data);
    var src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
    src.onended = function () { ac.close(); };
    src.start();
  });

  // Step 2: make the voice from the recording. quiet: no toasts (used to restore it on later visits).
  // The voice model needs about 1 GB of memory while it loads; phones often close the tab
  // instead of failing cleanly. A flag set during the build tells the next visit it crashed.
  var LOW_MEMORY = IS_PHONE || (navigator.deviceMemory && navigator.deviceMemory < 4);
  function neuralCrashed() { try { return localStorage.getItem('zoope-neural-building') === '1'; } catch (e) { return false; } }
  function markBuilding(on) { try { if (on) localStorage.setItem('zoope-neural-building', '1'); else localStorage.removeItem('zoope-neural-building'); } catch (e) { /* ignore */ } }

  // The light voice: a small synthesizer tuned to the voice scan. Works on every device.
  var liteModule = null;
  function lite() {
    if (!liteModule) {
      liteModule = import(new URL('js/litevoice.js', document.baseURI).href);
      liteModule.catch(function () { liteModule = null; });
    }
    return liteModule;
  }
  function liteReady() { return !!(state.liteVoice && state.liteVoice.gains); }
  function makeLite(reason) {
    if (!voiceSample || !state.voice) return Promise.resolve(false);
    neuralState = 'loading';
    renderVoice('Making your light voice…');
    return lite().then(function (m) {
      return m.make(voiceSample.data, voiceSample.rate, state.voice, showProgress);
    }).then(function (v) {
      state.liteVoice = v;
      neuralState = 'none';
      state.voiceMode = 'neural'; $('voiceMode').value = 'neural';
      save();
      $('neuralProgress').classList.add('hidden');
      renderVoice((reason ? reason + ' ' : '') + 'Your light voice is ready: tuned to your pitch (' + state.voice.pitchHz + ' Hz), pace and tone. It sounds synthetic, not like a recording of you.');
      toast('Your voice is ready');
      return true;
    }).catch(function (err) {
      neuralState = 'error';
      $('neuralProgress').classList.add('hidden');
      renderVoice('Your voice couldn\'t be made (' + (err && err.message ? err.message : 'unknown error') + '). zoope uses the browser voice tuned to your pitch and pace until then.');
      toast('Your voice couldn\'t be made', 'error');
      return false;
    });
  }

  function buildNeural(quiet) {
    if (!voiceSample || neuralState === 'loading') return Promise.resolve(false);
    // phones: the light voice, which always fits (the neural model needs ~1 GB of memory)
    if (IS_PHONE) {
      if (quiet) return Promise.resolve(liteReady());
      return makeLite('');
    }
    // phones: free the camera, face models and preview before the voice model loads
    if (IS_PHONE) {
      if (stream) stopCamera();
      if (stopPreview) { stopPreview(); stopPreview = null; }
    }
    markBuilding(true);
    neuralState = 'loading';
    renderVoice(quiet ? null : 'Loading the voice model…');
    return neural().then(function (m) {
      var progress = function (frac, label) { if (!quiet) showProgress(frac, label); };
      // a voice made earlier on this device is restored without the encoder; otherwise make it now
      return (quiet ? m.restore(progress) : Promise.resolve(false)).then(function (restored) {
        return restored || m.clone(voiceSample.data, voiceSample.rate, progress);
      });
    }).then(function () {
      markBuilding(false);
      neuralState = 'ready';
      state.neuralReady = true;
      state.voiceMode = 'neural'; $('voiceMode').value = 'neural';
      save();
      $('neuralProgress').classList.add('hidden');
      renderVoice('Your voice is ready. zoope will use it in meetings.');
      if (IS_PHONE) refreshAvatarBox();
      if (!quiet) toast('Your voice is ready');
      return true;
    }).catch(function (err) {
      markBuilding(false);
      neuralState = 'error';
      $('neuralProgress').classList.add('hidden');
      var why = 'Your voice clone couldn\'t be made: ' + (err && err.message ? err.message : 'network error') + '. Press Make my voice to try again. Until then zoope uses a light voice tuned to your pitch and pace, which does not sound like you.';
      if (quiet) { renderVoice(why); return false; }
      if (liteReady()) { renderVoice(why); toast('Your voice clone couldn\'t be made', 'error'); return false; }
      return makeLite(why);
    });
  }
  $('buildNeural').addEventListener('click', function () { buildNeural(false); });
  $('testNeural').addEventListener('click', function () {
    var n = state.profile.preferred || 'your zoope';
    speakAs('Hi everyone, ' + n + ' here. Happy to share a quick update.', function (l) { previewLevel = l; });
  });

  $('voiceMode').value = state.voiceMode === 'tts' ? 'tts' : 'neural';
  $('voiceMode').addEventListener('change', function () { state.voiceMode = $('voiceMode').value; save(); });

  // Speaks in the user's generated voice; falls back to the tuned browser voice when it isn't available.
  function speakAs(text, onLevel) {
    // phones load the voice model only when it is first needed
    if (!IS_PHONE && state.neuralReady && neuralState === 'none' && (state.voiceMode || 'neural') === 'neural') {
      return buildNeural(true).then(function () { return speakAs(text, onLevel); });
    }
    if ((state.voiceMode || 'neural') === 'neural' && neuralState === 'ready') {
      return neural().then(function (m) { return m.speak(text, onLevel); }).catch(function () {
        return ZoopeVoice.speak(text, state.voice, onLevel);
      });
    }
    if ((state.voiceMode || 'neural') === 'neural' && liteReady()) {
      return lite().then(function (m) { return m.speak(text, state.liteVoice, onLevel); }).catch(function () {
        return ZoopeVoice.speak(text, state.voice, onLevel);
      });
    }
    return ZoopeVoice.speak(text, state.voice, onLevel);
  }

  /* ------------------------------ checklist ------------------------------ */
  function checklistItems() {
    return [
      { label: 'Link a meeting account', done: Object.keys(state.platforms).length > 0, route: 'setup' },
      { label: 'Add your names', done: state.profile.names.length > 0 && state.chatStep === 'done', route: 'setup' },
      { label: 'Send zoope a note', done: (state.profile.notes || []).length > 0, route: 'notes' },
      { label: 'Scan your face', done: typeof SCAN_STEPS !== 'undefined' && scanCount() === SCAN_STEPS.length, route: 'clone' },
      { label: 'Make your voice', done: !!state.neuralReady || !!(state.liteVoice && state.liteVoice.gains), route: 'clone' },
      { label: 'Confirm a meeting', done: state.meetings.some(function (m) { return m.confirmed; }), route: 'meetings' }
    ];
  }
  function renderChecklist() {
    if (typeof voiceSample === 'undefined') return; // called during start-up, before the voice loads
    var items = checklistItems(), done = items.filter(function (i) { return i.done; }).length;
    $('checklistCount').textContent = done + '/' + items.length;
    $('checklistBar').style.width = (done / items.length * 100) + '%';
    $('checklistItems').innerHTML = items.map(function (i) {
      return '<li class="' + (i.done ? 'done' : '') + '"><a href="#/' + i.route + '">' + esc(i.label) + '</a></li>';
    }).join('');
    $('checklist').classList.toggle('hidden', done === items.length);
    document.querySelector('[data-state="setup"]').classList.toggle('done', items[0].done && items[1].done && items[2].done);
    document.querySelector('[data-state="clone"]').classList.toggle('done', items[3].done && items[4].done);
    var upcoming = state.meetings.filter(function (m) { return new Date(m.time).getTime() > Date.now() - 15 * 60 * 1000; }).length;
    $('navMeetingCount').textContent = upcoming || '';
  }

  /* ------------------------------ meetings ------------------------------ */
  function fmtDate(t) {
    var d = new Date(t);
    if (isNaN(d)) return { day: t, time: '' };
    return {
      day: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    };
  }

  function renderMeetings() {
    var list = $('meetingList');
    if (!state.meetings.length) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">' + icon('calendar') + '</div>' +
        '<h3>No meetings yet</h3><p>Add a meeting. zoope joins only after you confirm it.</p>' +
        '<button type="button" class="btn btn-secondary" data-act="new">' + icon('plus') + 'New meeting</button></div>';
      renderChecklist();
      return;
    }
    list.innerHTML = state.meetings.slice().sort(function (a, b) { return a.time.localeCompare(b.time); }).map(function (m) {
      var p = PLATFORMS[m.platform], when = fmtDate(m.time);
      var status = m.confirmed ? '<span class="pill pill-green pill-dot">Confirmed</span>' : '<span class="pill pill-amber pill-dot">Needs approval</span>';
      return '<div class="meeting" data-id="' + m.id + '">' +
        '<div class="m-title"><img src="' + p.img + '" alt="' + p.name + '"><div><b>' + esc(m.title) + '</b><span>' +
          (m.people.length ? 'With ' + esc(m.people.join(', ')) : p.name) + '</span></div></div>' +
        '<div class="m-when"><b>' + esc(when.day) + '</b><span>' + esc(when.time) + '</span></div>' +
        '<div>' + status + '</div>' +
        '<div class="m-actions">' +
          (m.confirmed
            ? '<button type="button" class="btn btn-primary btn-sm" data-act="join">Join now</button><button type="button" class="btn btn-ghost btn-sm" data-act="unconfirm">Revoke</button>'
            : '<button type="button" class="btn btn-secondary btn-sm" data-act="confirm">Approve</button>') +
          (m.link ? '<a class="btn btn-ghost btn-sm btn-icon" href="' + esc(m.link) + '" target="_blank" rel="noopener" title="Open link" aria-label="Open meeting link">' + icon('external') + '</a>' : '') +
          '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="delete" title="Delete" aria-label="Delete meeting">' + icon('trash') + '</button>' +
        '</div></div>';
    }).join('');
    renderChecklist();
  }

  function openMeetingForm(open) {
    $('meetingFormPanel').classList.toggle('hidden', !open);
    $('meetingError').textContent = '';
    if (open) {
      renderPlatforms();
      if (!$('mTime').value) {
        var d = new Date(Date.now() + 60 * 60 * 1000); d.setMinutes(0, 0, 0);
        $('mTime').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
      setTimeout(function () { $('mTitle').focus(); }, 30);
    }
  }
  $('newMeetingBtn').addEventListener('click', function () { openMeetingForm(true); });
  $('cancelMeeting').addEventListener('click', function () { openMeetingForm(false); });

  $('meetingForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var platform = $('mPlatform').value;
    if (!state.platforms[platform]) {
      $('meetingError').innerHTML = 'Link your ' + PLATFORMS[platform].name + ' account first in <a href="#/setup"><u>Setup</u></a>.';
      return;
    }
    var link = $('mLink').value.trim();
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    state.meetings.push({
      id: Date.now().toString(36),
      title: $('mTitle').value.trim(),
      platform: platform,
      link: link,
      time: $('mTime').value,
      people: $('mPeople').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      confirmed: false,
      joined: false
    });
    save(); renderMeetings();
    e.target.reset();
    openMeetingForm(false);
    toast('Meeting added. Approve it to let zoope attend.');
  });

  $('meetingList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.dataset.act;
    if (act === 'new') { openMeetingForm(true); return; }
    var id = btn.closest('.meeting').dataset.id;
    var m = state.meetings.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    if (act === 'confirm') {
      var missing = readinessProblems();
      confirmDialog({
        title: 'Send zoope to “' + m.title + '”?',
        body: 'At ' + esc(fmtDate(m.time).time || 'the start time') + ', zoope opens the meeting room for this ' + PLATFORMS[m.platform].name +
          ' meeting and speaks as <b>' + esc(state.profile.preferred || 'you') + '</b>, with your avatar and voice.' +
          (missing.length ? '<div class="dialog-note">Not ready yet: ' + esc(missing.join('; ')) + '.</div>' : ''),
        ok: 'Approve'
      }).then(function (ok) {
        if (!ok) return;
        m.confirmed = true; m.joined = false;
        save(); renderMeetings(); toast('zoope will attend “' + m.title + '”');
      });
      return;
    }
    if (act === 'delete') {
      confirmDialog({ title: 'Delete “' + m.title + '”?', body: 'This removes the meeting from zoope. It can\'t be undone.', ok: 'Delete', danger: true })
        .then(function (ok) {
          if (!ok) return;
          state.meetings = state.meetings.filter(function (x) { return x.id !== id; });
          save(); renderMeetings();
        });
      return;
    }
    if (act === 'unconfirm') { m.confirmed = false; toast('Approval revoked'); }
    if (act === 'join') joinMeeting(m);
    save(); renderMeetings();
  });

  function readinessProblems() {
    var out = [];
    if (!state.profile.names.length) out.push('add your names');
    if (!state.face) out.push('scan your head');
    else if (!state.face.portrait) out.push('rescan your face for the live avatar');
    if (!state.neuralReady && !(state.liteVoice && state.liteVoice.gains)) out.push(state.voice ? 'make your voice (it will use the browser voice)' : 'scan your voice');
    return out;
  }

  // Auto-join confirmed meetings when their time comes (while zoope is open).
  setInterval(function () {
    var now = Date.now();
    state.meetings.forEach(function (m) {
      var t = new Date(m.time).getTime();
      if (m.confirmed && !m.joined && now >= t && now - t < 15 * 60 * 1000 && !room) joinMeeting(m);
    });
  }, 15000);

  /* ------------------------------ meeting room ------------------------------ */
  var room = null;
  var COLORS = ['#e5484d', '#f76b15', '#12a594', '#8e4ec6', '#0090ff', '#d6409f', '#46a758'];

  function joinMeeting(m, opts) {
    opts = opts || {};
    ZoopeBrain.load();
    if (window.Notification && Notification.permission === 'default' && !m.demo) { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
    if (room) leaveRoom(false);
    m.joined = true; save();
    // a real meeting: the extension opens it in the platform's web app
    var live = !m.demo && !!m.link && ZoopeBridge.available() && !!ZoopeBridge.platformOf(m.link);
    var people = live ? [] : m.people.length ? m.people : ['Sam', 'Priya', 'Jordan'];
    var profile = JSON.parse(JSON.stringify(state.profile));
    if (!profile.names.length) { profile.names = ['Alex']; profile.preferred = 'Alex'; } // a stand-in name ("you" would match every "can you…")
    if (opts.sampleKnowledge && !(profile.notes || []).length) profile.knowledge = SAMPLE_KNOWLEDGE;

    room = {
      meeting: m,
      people: people,
      engine: new ZoopeEngine(profile, { attendees: live ? m.people : people, live: live }),
      live: live,
      session: null,
      level: 0,
      queue: Promise.resolve(),
      listener: null,
      demoTimer: null,
      started: Date.now()
    };

    // the room lives on the Demo page for the demo, and on the Meetings page otherwise
    room.page = m.demo ? 'demo' : 'meetings';
    var slot = $(m.demo ? 'demoSlot' : 'meetingSlot');
    slot.appendChild($('room'));
    slot.appendChild($('summary'));
    $('demoBtn').classList.toggle('hidden', !m.demo);
    $('room').classList.remove('hidden');
    $('summary').classList.add('hidden');
    $('roomTitle').textContent = m.title;
    $('roomPlatform').textContent = PLATFORMS[m.platform].name;
    $('roomTimer').textContent = '00:00';
    room.timer = setInterval(function () {
      var s = Math.floor((Date.now() - room.started) / 1000);
      $('roomTimer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);

    var stage = $('stage');
    stage.className = 'stage ' + m.platform;
    stage.querySelectorAll('.tile.other').forEach(function (t) { t.remove(); });
    people.forEach(function (p, i) {
      var t = document.createElement('div');
      t.className = 'tile other';
      t.dataset.name = p;
      t.innerHTML = '<div class="initials" style="background:' + COLORS[i % COLORS.length] + '">' + esc(p.charAt(0).toUpperCase()) + '</div><div class="tile-name">' + esc(p) + '</div>';
      stage.appendChild(t);
    });
    $('roomAvatarName').textContent = (profile.preferred || 'You') + ' · zoope';
    $('speaker').innerHTML = people.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join('');
    $('transcript').innerHTML = '';
    $('decisionLog').innerHTML = '';
    room.stopAnim = ZoopeAvatar.animate($('roomAvatar'), state.face, function () { return room ? faceState(room) : 0; }, { frame: 'bust' });
    $('roomState').classList.toggle('hidden', !live);
    $('focusMeeting').classList.toggle('hidden', !live);
    $('sayForm').classList.toggle('hidden', live);
    $('listenBtn').classList.toggle('hidden', live);

    var problems = readinessProblems();
    if (live) {
      startLive(room, profile);
      if (problems.length) sys('Not ready yet: ' + problems.join('; ') + '.');
    } else {
      sys((m.demo ? 'Joined as ' : 'Practice room: joined as ') + (profile.preferred || 'you') + '. Type what people say below, or use Listen.');
      if (!m.demo) {
        sys(!m.link ? 'This meeting has no link, so zoope can\'t join it for real. Add the link to join the actual call.'
          : !ZoopeBridge.platformOf(m.link) ? 'This link isn\'t a Zoom, Google Meet or Teams meeting link, so this is a practice room.'
          : IS_PHONE ? 'Real calls are joined from a computer with the zoope extension. On a phone, this is a practice room.'
          : 'To join the real call, install the zoope extension (see Setup). Until then, this is a practice room.');
      }
      if (problems.length) sys('Not ready yet: ' + problems.join('; ') + '.');
      ZoopeBrain.warm(aiPersona(room));
      respondWithAI(room, { task: 'join' });
    }
    if (currentRoute !== room.page) navigate(room.page);
    else setTimeout(function () { $('room').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }

  /* ---- real meetings (through the extension) ---- */
  var STATE_TEXT = {
    opening: 'Opening', prejoin: 'Pre-join', joining: 'Joining', lobby: 'In the lobby', joined: 'In the call', left: 'Left'
  };
  function setRoomState(st) {
    var el = $('roomState');
    el.textContent = STATE_TEXT[st] || st;
    el.className = 'pill pill-dot ' + (st === 'joined' ? 'pill-green' : st === 'left' ? '' : 'pill-amber');
  }
  function addTile(r, name) {
    if (r.people.indexOf(name) >= 0) return;
    r.people.push(name);
    var t = document.createElement('div');
    t.className = 'tile other';
    t.dataset.name = name;
    t.innerHTML = '<div class="initials" style="background:' + COLORS[(r.people.length - 1) % COLORS.length] + '">' + esc(name.charAt(0).toUpperCase()) + '</div><div class="tile-name">' + esc(name) + '</div>';
    $('stage').appendChild(t);
  }
  function holdAwake(r) {
    // a held Web Lock keeps Chrome from freezing this background tab during the call
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('zoope-live-call', function () { return new Promise(function (release) { r.releaseLock = release; }); }).catch(function () {});
    }
  }
  function startLive(r, profile) {
    holdAwake(r);
    var name = profile.fullName || profile.preferred || profile.names[0];
    // get the voice ready before anyone speaks, so the first reply isn't slowed by loading
    if (liteReady() && neuralState !== 'ready') lite().then(function (m) { return m.warm(); }).catch(function () {});
    if (neuralState === 'ready') neural().then(function (m) { return m.prewarm(['Yes?', 'Got it.', 'Okay, makes sense.', 'Yes, I can hear you.', 'Hi everyone, ' + (profile.preferred || '') + ' here.']); }).catch(function () {});
    setRoomState('opening');
    sys('Opening the ' + PLATFORMS[r.meeting.platform].name + ' meeting in a new tab. zoope joins as ' + name + '.');
    if (!((state.neuralReady || liteReady()) && (state.voiceMode || 'neural') === 'neural')) {
      sys('Your voice isn\'t made yet, so zoope will answer in the meeting chat instead of speaking.');
    }
    ZoopeBridge.join({ url: r.meeting.link, name: name, title: r.meeting.title, portrait: state.face && state.face.portrait })
      .then(function (sess) {
        if (room !== r) { sess.leave(); sess.end(); return; }
        r.session = sess;
        ZoopeBrain.warm(aiPersona(r)); // the AI is ready to answer before anyone speaks
        r.onLeave = function () { sess.leave(); if (r.releaseLock) r.releaseLock(); setTimeout(function () { sess.end(); }, 5000); };
        sess.on('status', function (ev) {
          if (room !== r) return;
          setRoomState(ev.state);
          if (ev.state === 'prejoin') sys('On the pre-join screen. Entering your name and turning on your avatar and voice.');
          else if (ev.state === 'joining') sys('Asked to join.');
          else if (ev.state === 'lobby') sys('Waiting for the host to let zoope in.');
          else if (ev.state === 'joined') {
            sys('In the call. zoope is following the live captions.');
            if (!r.greeted) { r.greeted = true; respondWithAI(r, { task: 'join' }); }
          } else if (ev.state === 'left') {
            sys(ev.detail || 'The meeting is over.');
            leaveRoom(true);
          }
        });
        sess.on('caption', function (ev) {
          if (room !== r || ev.self) return; // our own words, captioned back
          if (!ev.chat && wordCount(ev.text) >= 5) yieldTurn(r, ev.speaker);
          addTile(r, ev.speaker);
          hear(ev.speaker, ev.text, ev.chat);
        });
        // someone is still talking: zoope's AI starts on what they've said so far
        sess.on('partial', function (ev) {
          if (room !== r) return;
          if (wordCount(ev.text) >= 5) yieldTurn(r, ev.speaker);
          preview(r, ev.speaker, ev.text);
        });
        sess.on('chatSent', function (ev) { if (room === r && !ev.ok) sys('Couldn\'t post in the meeting chat.'); });
        sess.on('log', function (ev) {
          if (/^(captions|chat box)/.test(ev.text) && room === r) sys(ev.text.replace(/^captions: /, ''));
          if (window.console) console.info('[zoope extension]', ev.text);
        });
      })
      .catch(function (err) {
        if (room !== r) return;
        setRoomState('left');
        sys('Couldn\'t open the meeting: ' + err.message);
      });
  }
  // zoope is for computers: on a phone, the app pages show a notice instead
  if (IS_PHONE) document.documentElement.classList.add('phone');
  // browser extensions don't run on phones, so real calls are joined from a computer
  if (IS_PHONE) {
    $('extStatus').textContent = 'Needs a computer';
    $('extHint').textContent = 'Phone browsers can\'t run extensions. Install it in Chrome or Edge on a computer; zoope joins calls from there. On this phone you can set up, take notes, run the demo and read summaries.';
    document.querySelector('.ext-steps').classList.add('hidden');
  }
  ZoopeBridge.onAvailable(function (v) {
    $('extStatus').textContent = 'Installed · v' + v;
    $('extStatus').className = 'pill pill-green pill-dot';
    $('extHint').textContent = 'Meetings with a Zoom, Meet or Teams link join the real call.';
    document.querySelector('.ext-steps').classList.add('hidden');
  });
  // which version of zoope this is, so an outdated copy of the site is easy to spot
  var BUILD = '2026-10-03 · AI v13';
  $('buildTag').textContent = BUILD;
  ZoopeBrain.onStatus(function (st) {
    if (st.state === 'ready' && room) ZoopeBrain.warm(aiPersona(room));
    // a banner in the meeting room whenever the AI isn't ready, so it's clear why replies are simple
    var ban = $('aiBanner');
    ban.classList.toggle('hidden', st.state === 'ready');
    ban.classList.toggle('err', st.state === 'error');
    ban.textContent = st.state === 'loading' ? (st.error ? 'AI engine: ' + st.error + '…' : 'AI engine loading: ' + Math.round(st.progress * 100) + '%. zoope listens but stays quiet until it is ready (first time only; it is saved after).')
      : st.state === 'error' ? 'AI engine not running: ' + (st.error || 'unknown error') + '. zoope listens but stays quiet.'
      : 'AI engine starting…';
    var text = st.state === 'ready' ? 'AI: ready' + (st.device === 'chrome-ai' ? ' (Chrome AI)' : st.device === 'webgpu' ? ' (GPU)' : '')
      : st.state === 'loading' ? 'AI: loading ' + Math.round(st.progress * 100) + '%'
      : st.state === 'error' ? 'AI: not running' : 'AI: starting';
    ['brainState', 'brainStateNav'].forEach(function (id) {
      var el = $(id);
      el.textContent = text;
      el.className = 'pill ' + (st.state === 'ready' ? 'pill-green pill-dot' : st.state === 'loading' ? 'pill-amber' : '');
    });
  });
  // personality and style: used by the AI engine for every reply
  $('styleSelect').value = state.profile.style || 'friendly';
  $('styleInstructions').value = state.profile.instructions || '';
  $('styleSelect').addEventListener('change', function () { state.profile.style = $('styleSelect').value; save(); $('styleSaved').textContent = 'Saved.'; });
  $('styleInstructions').addEventListener('input', function () { state.profile.instructions = $('styleInstructions').value.trim().slice(0, 600); save(); $('styleSaved').textContent = 'Saved.'; });

  // click the AI badge to test it with a simple question
  $('brainStateNav').style.cursor = 'pointer';
  $('brainStateNav').addEventListener('click', function () {
    var st = ZoopeBrain.status();
    if (st.state !== 'ready') { toast(st.state === 'loading' ? 'The AI is still loading (' + Math.round(st.progress * 100) + '%).' : 'The AI isn\'t running: ' + (st.error || 'not started'), 'error'); return; }
    toast('Asking the AI: “What is 12 times 7?”');
    var t0 = Date.now(), out = [];
    ZoopeBrain.generate({ name: state.profile.preferred || 'Alex', speaker: 'Test', text: 'What is 12 times 7?', notes: [], history: [], firstTimeout: 20000 }, function (x) { out.push(x); })
      .then(function (res) {
        if (res && out.length) toast('AI (' + st.device + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s): ' + out.join(' '));
        else toast('The AI didn\'t answer: ' + (ZoopeBrain.lastError() || 'no output'), 'error');
      });
  });
  // the AI engine is always on: on a computer it starts as soon as zoope opens
  if (!IS_PHONE) setTimeout(function () { ZoopeBrain.load(); }, 1500);
  $('focusMeeting').addEventListener('click', function () { if (room && room.session) room.session.focus(); });

  /*
   * Asks the user for help with a question zoope couldn't answer — but only when it
   * matters: the question was put to the user (by name, one-on-one, or right after
   * zoope spoke), it's a real question, and the user hasn't been pinged in the last
   * 90 seconds (later ones wait in the summary's "Waiting on you").
   */
  var lastPing = 0;
  function maybePing(r, d) {
    var directed = d.reasons.some(function (x) { return /Called by name|One-on-one|Continuing after|Follow-up/.test(x); });
    var real = d.text.split(/\s+/).length >= 4 && /\?|^(what|when|where|who|why|how|can|could|will|would|do|does|did|is|are)\b/i.test(d.text);
    if (!directed || !real || Date.now() - lastPing < 90000) return;
    lastPing = Date.now();
    var msg = d.speaker + ' asked: “' + d.text + '”';
    line('ping', 'Needs you', msg + ' Type an answer in the note box and zoope will say it.');
    $('liveNote').placeholder = 'Answer for ' + d.speaker + ': zoope says it at the next pause';
    try { beep(988, 140); setTimeout(function () { beep(1318, 160); }, 170); } catch (e) { /* no audio */ }
    var t0 = document.title, n = 0, flash = setInterval(function () { document.title = n++ % 2 ? t0 : '● zoope needs you'; if (n > 9) { clearInterval(flash); document.title = t0; } }, 700);
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification('zoope needs you', { body: msg, tag: 'zoope-ping' }); } catch (e) { /* not allowed here */ }
    }
  }

  function sys(text) { line('sys', null, text); }
  function line(cls, who, text) {
    var d = document.createElement('div');
    d.className = 'line ' + (cls || '');
    d.innerHTML = who ? '<span class="line-who">' + esc(who) + '</span><span class="line-text">' + esc(text) + '</span>' : esc(text);
    $('transcript').appendChild(d);
    $('transcript').scrollTop = $('transcript').scrollHeight;
  }

  function highlight(name, on) {
    document.querySelectorAll('#stage .tile').forEach(function (t) {
      if ((name === null && t.classList.contains('you-tile')) || t.dataset.name === name) t.classList.toggle('speaking', on);
    });
  }

  // Records how long a reply took: from the line being heard to the reply text, and to the voice starting.
  function timing(r, tText, tVoice, how) {
    if (r.timed || !r.t0) return;
    r.timed = true;
    var t = function (ms) { return (Math.max(0, ms) / 1000).toFixed(1) + ' s'; };
    var bs = ZoopeBrain.status();
    var msg = 'Reply text ' + t(tText - r.t0) + ' · voice ' + (tVoice ? t(tVoice - r.t0) : '—') + ' after the line was heard · ' + how +
      ' · AI ' + (bs.state === 'ready' ? bs.device : bs.state) + (window.crossOriginIsolated ? ' · multi-threaded' : ' · single-threaded');
    $('diag').textContent = msg;
    (r.timings = r.timings || []).push({ text: tText - r.t0, voice: tVoice ? tVoice - r.t0 : null, how: how });
    window.__zoopeTimings = r.timings;
  }
  function timedOut(r, out, tText, how) {
    // voice start = when the first audio is scheduled to play (a wall-clock time, so it works in background tabs)
    var first = true, onEnv = out.onEnvelope;
    out.onEnvelope = function (env) { if (first) { first = false; timing(r, tText, env.at, how); } env.smile = r.expr || 0; onEnv(env); };
    return out;
  }

  /*
   * What the avatar's face does right now: the mouth shape comes from the audio being played (see the
   * voices' mouth timelines), the expression from the line being said, and while the AI is writing a
   * reply the eyes drift away briefly, as people's do when they think.
   */
  function faceState(r) {
    var l = r.level, o = l && typeof l === 'object' ? Object.assign({}, l) : { open: l || 0, wide: 0, round: 0, teeth: 0 };
    o.smile = r.speaking ? r.expr || 0 : 0;
    o.think = r.thinking ? 1 : 0;
    return o;
  }
  // How much a line smiles: warm or upbeat words and exclamations lift the mouth corners a little; bad news doesn't.
  function exprFor(text) {
    var t = String(text).toLowerCase(), up = 0;
    if (/!/.test(t)) up += 0.25;
    if (/\b(great|glad|nice|thanks|thank you|happy|love|awesome|good news|excited|congrats|congratulations|welcome|haha|fun|perfect|hi|hello|hey)\b/.test(t)) up += 0.35;
    if (/\b(sorry|unfortunately|problem|issue|delay|delayed|blocked|bad|worried|can't|cannot|won't)\b/.test(t)) up -= 0.4;
    return Math.max(0, Math.min(0.7, 0.12 + up));
  }

  function aiSay(text, opts) {
    var r = room, noPause = opts && opts.noPause, tText = Date.now(), ep = r.epoch || 0;
    r.queue = r.queue.then(function () {
      if (room !== r || ep !== (r.epoch || 0)) return; // someone talked over zoope: this part isn't said
      // a short natural pause before speaking; in real calls keep it tight so replies don't lag
      // in a real call the zoope tab is in the background, where Chrome delays timers by up to a second,
      // so the live path uses no timers at all
      return (r.live || noPause ? Promise.resolve() : new Promise(function (res) { setTimeout(res, 300); })).then(function () {
        if (room !== r || ep !== (r.epoch || 0)) return;
        r.speaking = true; r.speakStart = Date.now(); r.expr = exprFor(text);
        if (r.live) {
          if (!r.session) return;
          var neuralOk = state.neuralReady && (state.voiceMode || 'neural') === 'neural' && neuralState === 'ready';
          if (!neuralOk && liteReady() && (state.voiceMode || 'neural') === 'neural') {
            line('ai', r.engine.preferred + ' · zoope', text);
            highlight(null, true);
            return lite().then(function (m) { return m.speak(text, state.liteVoice, function (l) { r.level = l; }, timedOut(r, r.session.voiceOut(), tText, 'light voice')); })
              .catch(function () { line('sys', null, 'The voice failed, so this went to the chat.'); return r.session.chat(text); });
          }
          if (!neuralOk) {
            line('ai', r.engine.preferred + ' · zoope (chat)', text);
            timing(r, tText, null, 'chat (no voice made)');
            return r.session.chat(text);
          }
          line('ai', r.engine.preferred + ' · zoope', text);
          highlight(null, true);
          return neural().then(function (m) { return m.speak(text, function (l) { r.level = l; }, timedOut(r, r.session.voiceOut(), tText, 'cloned voice')); })
            .catch(function () { line('sys', null, 'The voice failed, so this went to the chat.'); return r.session.chat(text); });
        }
        line('ai', r.engine.preferred + ' · zoope', text);
        highlight(null, true);
        var how = neuralState === 'ready' ? 'cloned voice' : liteReady() ? 'light voice' : 'browser voice';
        return speakAs(text, function (l) { r.level = l; if (l && (l.open || l) > 0.04) timing(r, tText, Date.now(), how); });
      }).then(function () { highlight(null, false); r.level = 0; r.speaking = false; });
    });
    return r.queue;
  }

  function hear(speaker, text, viaChat) {
    if (!room || !text) return;
    line('', speaker + (viaChat ? ' (chat)' : ''), text);
    highlight(speaker, true);
    setTimeout(function () { highlight(speaker, false); }, 900);
    var r = room, before = r.engine.followUps.length;
    r.t0 = Date.now(); r.timed = false;
    var d = r.engine.hear(speaker, text);
    logDecision(d);
    keepReading(r);
    // an answer the AI started while this line was still being said: used if it was for exactly these words
    var spec = r.spec, task = d.summon ? 'summon' : 'reply';
    r.spec = null;
    var useSpec = d.speak && spec && spec.commit && spec.speaker === speaker && spec.task === task && sameWords(spec.text, text);
    if (spec && !useSpec && spec.control.cancel) spec.control.cancel();
    if (!d.speak) return;
    var directedQ = r.engine.isQuestion(text) && (d.addressed || d.oneOnOne);
    var gopts = { task: task, speaker: speaker, text: text, oneOnOne: d.oneOnOne, aiCheck: d.intent === 'aicheck' };
    (useSpec ? inTurn(r, function () { return spec.commit(d); }) : respondWithAI(r, gopts, d)).then(function (res) {
      if (room !== r) return;
      // the notes didn't cover it (or no reply could be made): it waits on the user
      if (res && res.ask || !res && directedQ) { r.engine.followUp(speaker, text); maybePing(r, d); }
    });
  }

  /*
   * Someone is still talking. If zoope would answer what they've said so far, its AI starts writing the
   * answer now, held back; when the finished line has the same words, the answer is spoken at once
   * (otherwise it is dropped). Chrome's AI and the GPU run side by side, so this costs nothing; on the
   * CPU a dropped answer would hold up the next one, so it waits for the finished line there.
   */
  function preview(r, speaker, text) {
    if (!ZoopeBrain.ready() || ZoopeBrain.status().device === 'wasm' || r.aiBusy || r.speaking) return;
    if (r.spec && r.spec.speaker === speaker && sameWords(r.spec.text, text)) return;
    if (r.spec && r.spec.control.cancel) r.spec.control.cancel();
    r.spec = null;
    var d = r.engine.peek(speaker, text);
    if (!d.speak) return;
    r.spec = { speaker: speaker, text: text, control: {} };
    generateReply(r, { task: d.summon ? 'summon' : 'reply', speaker: speaker, text: text, oneOnOne: d.oneOnOne, aiCheck: d.intent === 'aicheck' }, null, r.spec);
  }
  // Chrome's AI reads each line of the meeting as it's said, so a reply only has to read the question
  function keepReading(r) { ZoopeBrain.warm(Object.assign(aiPersona(r), { history: r.engine.history })); }
  function wordCount(t) { return (String(t).match(/[A-Za-z0-9']+/g) || []).length; }
  function sameWords(a, b) {
    var f = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim(); };
    return f(a) === f(b);
  }

  /*
   * The speaking pipeline: conversation → the AI engine generates a reply → each sentence becomes
   * speech as soon as it's written → the avatar's mouth follows that audio → back to idle.
   * Nothing is scripted: if the AI engine isn't running, zoope stays quiet (and says why, once).
   * gopts: { task: 'reply' | 'summon' | 'join' | 'relay', speaker, text, oneOnOne }
   */
  function respondWithAI(r, gopts, decision) {
    return inTurn(r, function () { return generateReply(r, gopts, decision); });
  }
  // one reply at a time, so each reply knows what zoope just said
  function inTurn(r, fn) {
    r.aiBusy = (r.aiBusy || 0) + 1;
    var run = (r.aiChain || Promise.resolve()).then(function () { return room === r ? fn() : null; });
    r.aiChain = run.catch(function () {}).then(function () { r.aiBusy--; });
    return run;
  }
  // spec: an early answer (see preview()): written now, spoken only once spec.commit(decision) is called
  function generateReply(r, gopts, decision, spec) {
    if (!ZoopeBrain.ready()) { if (!spec) aiNotReady(r); return Promise.resolve(null); }
    var p = state.profile;
    var notes = (p.notes || []).map(function (n) { return n.text; }).concat(r.meeting.demo && !(p.notes || []).length ? [SAMPLE_KNOWLEDGE] : []);
    var hist = r.engine.history;
    var held = !!spec, early = [], pending = [], talking = false, firstSaid = false, ep0 = r.epoch || 0, delivered = [];
    var control = spec ? spec.control : {};
    if (!spec) { setThinking(r, true); r.genControl = control; }
    var cut = function () { return (r.epoch || 0) !== ep0; };
    // the first piece is spoken the moment it's written; what's written while it plays follows as one
    // smooth utterance as soon as it ends (so there is no wait for the whole reply, and no gap)
    var pump = function () {
      if (cut()) pending.length = 0;
      if (talking || !pending.length || room !== r) return;
      talking = true;
      var text = pending.splice(0).join(' ');
      aiSay(text, firstSaid ? { noPause: true } : null).then(function () { talking = false; pump(); });
      firstSaid = true;
    };
    var deliver = function (sentence) {
      if (room !== r || cut()) return;
      setThinking(r, false);
      delivered.push(sentence);
      pending.push(sentence);
      pump();
    };
    var wrapUp = function (res) {
      setThinking(r, false);
      if (room !== r) return null;
      pump();
      // talked over: what zoope had started saying counts as said, and nothing waits on the user
      if (cut()) {
        if (delivered.length) { r.engine.said(delivered.join(' '), decision); keepReading(r); }
        return { said: delivered, ask: false, cut: true };
      }
      if (!res) {
        var err = ZoopeBrain.lastError();
        if (err && !r.aiErrorShown) { r.aiErrorShown = true; sys('The AI engine hit an error (' + err + '), so zoope stayed quiet.'); }
        return null;
      }
      var said = res.said.join(' ');
      if (said) { r.engine.said(said, decision); r.engine.markShared(said); keepReading(r); }
      return res;
    };
    var gen = ZoopeBrain.generate(Object.assign(aiPersona(r), {
      notes: notes,
      // the line being answered is passed separately, so leave that exact entry out of the history
      history: hist.filter(function (h, i) {
        if (h.ai || h.speaker !== gopts.speaker || h.text !== gopts.text) return true;
        for (var j = i + 1; j < hist.length; j++) if (!hist[j].ai && hist[j].speaker === gopts.speaker && hist[j].text === gopts.text) return true;
        return false;
      }),
      fullHistory: hist.slice(),
      shares: r.engine.sharesToMention().map(function (n) { return n.text; }),
      firstTimeout: ZoopeBrain.status().device === 'webgpu' ? 10000 : 20000,
      control: control
    }, gopts), function (sentence) { if (held) early.push(sentence); else deliver(sentence); });
    if (!spec) return gen.then(wrapUp);
    spec.task = gopts.task;
    spec.commit = function (d) {
      decision = d; held = false; ep0 = r.epoch || 0; r.genControl = control;
      if (early.length) early.splice(0).forEach(deliver); else setThinking(r, true);
      return gen.then(wrapUp);
    };
    return gen;
  }
  // While the AI writes a reply, the avatar looks away briefly, as people do when they think (in the
  // meeting too).
  function setThinking(r, v) {
    v = !!v;
    if (r.thinking === v) return;
    r.thinking = v;
    if (r.live && r.session) r.session.face({ think: v });
  }
  // Someone talks over zoope: like a person, it stops mid-sentence and lets them speak.
  function yieldTurn(r, speaker) {
    if (!r.speaking || Date.now() - (r.speakStart || 0) < 600) return;
    r.epoch = (r.epoch || 0) + 1;
    if (r.genControl && r.genControl.cancel) r.genControl.cancel();
    if (neuralState === 'ready') neural().then(function (m) { if (m.stop) m.stop(); }).catch(function () {});
    if (liteReady()) lite().then(function (m) { if (m.stop) m.stop(); }).catch(function () {});
    if (r.session) r.session.cutVoice();
    r.level = 0;
    sys(r.engine.preferred + ' stopped talking so ' + speaker + ' could speak.');
  }
  // who zoope is, for the AI (the same all meeting, so the AI can keep it loaded)
  function aiPersona(r) {
    var p = state.profile;
    return { name: r.engine.preferred, fullName: p.fullName, style: p.style, instructions: p.instructions };
  }
  function aiNotReady(r) {
    if (r.aiWaitShown) return;
    r.aiWaitShown = true;
    var bs = ZoopeBrain.status();
    sys(bs.state === 'loading' ? 'The AI engine is still loading (' + Math.round(bs.progress * 100) + '%). zoope listens but stays quiet until it is ready; it doesn\'t use scripted replies.'
      : 'The AI engine isn\'t running' + (bs.error ? ' (' + bs.error + ')' : '') + '. zoope listens but stays quiet until it is; connect it with the extension\'s Connect button.');
  }

  function logDecision(d) {
    var el = document.createElement('div');
    el.className = 'decision';
    var pct = Math.max(0, Math.min(1, d.score / 1.5)) * 100;
    el.innerHTML = '<span class="pill ' + (d.speak ? 'pill-accent' : '') + '">' + (d.speak ? 'Respond' : 'Quiet') + '</span>' +
      '<div><div class="decision-text"><b>' + esc(d.speaker) + '</b>' + esc(d.text) + '</div>' +
      '<div class="decision-why">' + esc(d.intent) + ' · ' + d.reasons.map(esc).join(' · ') + '</div></div>' +
      '<span class="score"><i style="--w:' + pct.toFixed(0) + '%"></i><em>' + d.score.toFixed(2).replace('-', '−') + '</em></span>';
    $('decisionLog').prepend(el);
  }

  $('liveNoteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('liveNote').value.trim();
    if (!v || !room) return;
    $('liveNote').value = '';
    sys('Your note: ' + v);
    room.engine.relay(v);
    var r = room;
    // the AI says it in its own words; without the AI, zoope says your note exactly as you wrote it
    if (ZoopeBrain.ready()) respondWithAI(r, { task: 'relay', text: v });
    else { aiSay(v); r.engine.said(v); }
  });

  $('sayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('sayInput').value.trim();
    if (!v) return;
    $('sayInput').value = '';
    hear($('speaker').value, v);
  });

  function setListenLabel(on) { $('listenBtn').querySelector('span').textContent = on ? 'Stop listening' : 'Listen'; }
  $('listenBtn').addEventListener('click', function () {
    if (!room) return;
    if (room.listener) { room.listener.stop(); room.listener = null; setListenLabel(false); return; }
    var who = room.people[0];
    room.listener = ZoopeVoice.listen(function (text) {
      if (window.speechSynthesis && speechSynthesis.speaking) return; // don't hear ourselves
      hear($('speaker').value || who, text);
    }, function (on) { setListenLabel(on); if (!on && room) room.listener = null; });
    if (!room.listener) toast('Live listening needs speech recognition (Chrome or Edge). You can still type lines.', 'error');
  });

  $('demoBtn').addEventListener('click', startDemo);
  $('demoBtnTop').addEventListener('click', startDemo);

  function startDemo() {
    var demoMeeting = room ? room.meeting : null;
    var people = ['Sam', 'Priya', 'Jordan'];
    if (!demoMeeting || !demoMeeting.demo) {
      demoMeeting = { id: 'demo', demo: true, title: 'Weekly sync', platform: Object.keys(state.platforms)[0] || 'zoom', people: people, time: new Date().toISOString() };
    }
    joinMeeting(demoMeeting, { sampleKnowledge: true });
    $('demoIntro').classList.add('hidden');
    $('demoBtnTop').classList.add('hidden');
    if (!(state.profile.notes || []).length) sys('You haven\'t sent zoope any notes, so this demo uses sample notes.');
    var me = room.engine.preferred;
    var script = [
      ['Sam', 'Hi everyone! Can everyone hear me okay?'],
      ['Priya', 'Yep. Let\'s start with the roadmap. Sam, how is the mobile app going?'],
      ['Sam', 'It\'s on track, we should ship the beta next week, and'],
      ['Sam', 'the login bug is fixed now.'],
      ['Priya', me + ', what\'s the status of the website redesign?'],
      ['Jordan', 'When does it launch exactly?'],
      ['Priya', 'Jordan, can you send the budget numbers by Friday?'],
      ['Jordan', 'Sure, will do.'],
      ['Sam', 'Hey Jay, can you look at my pull request by tomorrow?'],
      ['Priya', 'Does anyone have thoughts on when to do design reviews?'],
      ['Priya', me + ', could you draft the launch email by Thursday?'],
      ['Priya', 'Great. Thanks everyone, that\'s all for today. Bye!']
    ];
    var r = room, i = 0;
    (function next() {
      if (room !== r || i >= script.length) return;
      var s = script[i++];
      hear(s[0], s[1]);
      r.queue.then(function () { r.demoTimer = setTimeout(next, 1400); });
    })();
  }

  $('leaveRoom').addEventListener('click', function () { leaveRoom(true); });

  function leaveRoom(showSummary) {
    if (!room) return;
    var r = room;
    room = null;
    if (r.listener) r.listener.stop();
    clearTimeout(r.demoTimer);
    clearInterval(r.timer);
    if (r.stopAnim) r.stopAnim();
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (r.onLeave) r.onLeave();
    setListenLabel(false);
    $('room').classList.add('hidden');
    if (r.page === 'demo') {
      $('demoIntro').classList.remove('hidden');
      $('demoBtnTop').classList.remove('hidden');
      $('demoBtnTop').querySelector('span').textContent = 'Run again';
    }
    var summary = finishMeeting(r);
    if (showSummary && summary) renderSummary(summary, $('summary').parentNode);
    else $('summary').classList.add('hidden');
  }

  // Writes the meeting's summary, keeps it in the history, and marks shared notes as said.
  function finishMeeting(r) {
    var people = r.engine.history.filter(function (h) { return !h.ai; });
    if (!people.length) return null;
    var p = state.profile;
    var sum = ZoopeSummarize.summarize(r.engine.history, {
      title: r.meeting.title, platform: PLATFORMS[r.meeting.platform] ? PLATFORMS[r.meeting.platform].name : '',
      started: r.started, ended: Date.now(), user: r.engine.preferred,
      userNames: (p.names || []).concat(p.fullName ? [p.fullName] : []), attendees: r.people,
      followUps: r.engine.followUps, sharedNotes: r.engine.sharedNotes
    });
    sum.id = 's' + Date.now().toString(36);
    sum.demo = !!r.meeting.demo;
    sum.unknownNames = r.engine.unknownNames;
    if (!r.meeting.demo) {
      var ids = r.engine.sharedNotes.map(function (n) { return n.id; });
      (p.notes || []).forEach(function (n) {
        if (ids.indexOf(n.id) >= 0) { n.kind = 'shared'; n.sharedIn = r.meeting.title; n.sharedAt = Date.now(); }
      });
    }
    state.summaries = [sum].concat(state.summaries || []).slice(0, 40);
    save();
    renderNotes();
    renderSummaries();
    return sum;
  }

  var shownSummary = null;
  function renderSummary(sum, container) {
    shownSummary = sum;
    container.appendChild($('summary'));
    function section(title, items, fmt) {
      if (!items.length) return '';
      return '<div class="summary-section"><h3>' + title + '</h3><ul>' + items.map(fmt).join('') + '</ul></div>';
    }
    var html = '<p class="sum-overview">' + esc(sum.overview) + '</p>';
    (sum.unknownNames || []).forEach(function (n) {
      html += '<div class="summary-section name-ask"><p>Someone was called <b>“' + esc(n) + '”</b>. Do people call you that?</p>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-addname="' + esc(n) + '">Add to my names</button></div>';
    });
    html += section('Key points', sum.keyPoints, function (k) { return '<li><div><b>' + esc(k.speaker) + ':</b> ' + esc(k.text) + '</div></li>'; }) +
      section('Decisions', sum.decisions, function (d) { return '<li><div>' + esc(d.text) + ' <span>· ' + esc(d.speaker) + '</span></div></li>'; }) +
      section('Action items', sum.actionItems, function (a) {
        return '<li><div><b>' + esc(a.owner) + ':</b> ' + esc(a.task) + (a.due ? ' <span>· ' + esc(a.due) + '</span>' : '') +
          (a.owner !== a.from ? ' <span>(asked by ' + esc(a.from) + ')</span>' : '') + '</div></li>';
      }) +
      section('Waiting on you', sum.followUps, function (f) { return '<li><div>' + esc(f.from) + ' asked: “' + esc(f.text) + '”</div></li>'; }) +
      section('Shared from your notes', sum.sharedNotes, function (n) { return '<li><div>' + esc(n) + '</div></li>'; }) +
      section('What your avatar said', sum.said, function (t) { return '<li><div>' + esc(t) + '</div></li>'; });
    $('summaryTitle').textContent = sum.title + (sum.started ? ' · ' + new Date(sum.started).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
    $('summaryBody').innerHTML = html;
    $('summary').classList.remove('hidden');
    $('summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('copySummary').addEventListener('click', function () {
    if (!shownSummary) return;
    (navigator.clipboard ? navigator.clipboard.writeText(shownSummary.markdown) : Promise.reject())
      .then(function () { toast('Summary copied'); }, function () { toast('Copy isn\'t available here. Use .md instead.', 'error'); });
  });
  $('downloadSummary').addEventListener('click', function () {
    if (!shownSummary) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([shownSummary.markdown], { type: 'text/markdown' }));
    a.download = (shownSummary.title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-summary.md';
    document.body.appendChild(a); a.click(); a.remove();
  });

  function renderSummaries() {
    var list = state.summaries || [];
    $('navSummaryCount').textContent = list.length || '';
    if (!list.length) {
      $('summaryList').innerHTML = '<div class="empty"><div class="empty-icon">' + icon('list') + '</div><h3>No summaries yet</h3>' +
        '<p>After zoope attends a meeting (or you run the demo), its summary appears here.</p><a href="#/demo" class="btn btn-secondary">Run the demo</a></div>';
      return;
    }
    $('summaryList').innerHTML = list.map(function (sm) {
      var when = sm.started ? new Date(sm.started).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return '<div class="sum-row" data-sum="' + sm.id + '"><div><b>' + esc(sm.title) + (sm.demo ? ' <span class="pill">Demo</span>' : '') + '</b><p>' + esc(sm.overview) + '</p></div>' +
        '<span class="mono muted-2">' + esc(when) + '</span></div>';
    }).join('');
  }
  $('summaryList').addEventListener('click', function (e) {
    var row = e.target.closest('[data-sum]');
    if (!row) return;
    var sm = (state.summaries || []).filter(function (x) { return x.id === row.dataset.sum; })[0];
    if (sm) renderSummary(sm, $('summarySlot'));
  });

  $('summaryBody').addEventListener('click', function (e) {
    var n = e.target.dataset.addname;
    if (!n) return;
    addNames([n]); save(); renderChips();
    e.target.disabled = true; e.target.textContent = 'Added';
    bot('Thanks. I\'ll also answer to “' + n + '” from now on.');
    toast('“' + n + '” added to your names');
  });

  /* ------------------------------- routing ------------------------------- */
  var ROUTES = ['home', 'setup', 'clone', 'notes', 'demo', 'meetings', 'summaries'];
  var TITLES = { home: 'zoope', setup: 'Setup', clone: 'Face & voice', notes: 'Notes', demo: 'Demo meeting', meetings: 'Meetings', summaries: 'Summaries' };
  var currentRoute = null, navToken = 0;
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function routeFromHash() {
    var r = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
    return ROUTES.indexOf(r) >= 0 ? r : 'home';
  }

  function navigate(route) {
    var hash = '#/' + (route === 'home' ? '' : route);
    if (location.hash !== hash) location.hash = hash;
    else go(route);
  }

  function showPage(route) {
    document.querySelectorAll('.page').forEach(function (pg) { pg.classList.toggle('active', pg.dataset.page === route); });
    document.querySelectorAll('.side-nav a').forEach(function (a) {
      var on = a.dataset.route === route;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.body.dataset.route = route;
    $('crumbCurrent').textContent = TITLES[route];
    document.title = route === 'home' ? 'zoope · Your AI meeting stand-in' : TITLES[route] + ' · zoope';
    if (route === 'demo') {
      var live = !!(room && room.page === 'demo');
      $('demoIntro').classList.toggle('hidden', live);
      $('demoBtnTop').classList.toggle('hidden', live);
    }
    window.scrollTo(0, 0);
  }

  function go(route, instant) {
    if (route === currentRoute) return;
    var prev = currentRoute;
    currentRoute = route;
    if (prev === 'clone') stopCamera();
    if (room && room.page === prev) leaveRoom(false);
    var token = ++navToken;
    // app to app: the sidebar stays put and only the content fades in (CSS).
    // site to app (or back): cross-fade the whole shell.
    var crossing = prev && ((prev === 'home') !== (route === 'home'));
    if (instant || reduceMotion || !crossing) { showPage(route); return; }
    document.body.classList.add('leaving');
    setTimeout(function () {
      if (token !== navToken) return;
      showPage(route);
      document.body.classList.remove('leaving');
    }, 170);
  }

  window.addEventListener('hashchange', function () { go(routeFromHash()); });

  /* ----------------------------- marketing site ----------------------------- */
  document.querySelectorAll('[data-scroll]').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = $(b.dataset.scroll);
      if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 64, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  });
  window.addEventListener('scroll', function () {
    $('siteHeader').classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  // reveal marketing sections as they scroll into view
  var revealTargets = document.querySelectorAll('.section-head, .steps li, .split > *, .feature-grid article, .stat-grid, .cta-inner');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    revealTargets.forEach(function (el, i) {
      el.classList.add('reveal');
      el.style.transitionDelay = (i % 3) * 60 + 'ms';
      io.observe(el);
    });
  }

  /* -------------------------------- init -------------------------------- */
  renderPlatforms();
  renderChips();
  startChat();
  renderNotes();
  renderSummaries();
  refreshAvatarBox();
  renderMeetings();
  renderProfile();
  if (voiceSample) $('scanVoiceStatus').textContent = 'Voice scanned. You can scan again at any time.';
  renderVoice(voiceSample ? (liteReady() && (IS_PHONE || !state.neuralReady) ? 'Your light voice is ready, tuned to your pitch, pace and tone.' : state.neuralReady && !IS_PHONE ? 'Loading your voice…' : IS_PHONE ? PHONE_VOICE_MSG : 'Next, make your voice from this recording.') : null);
  // the model was downloaded before: rebuild the voice in the background
  // reload the voice in the background, except on phones (too heavy to do unasked) or after a crash
  if (neuralCrashed()) {
    markBuilding(false);
    neuralState = 'error';
    renderVoice('Making your voice closed this tab last time (the computer ran out of memory). Close other tabs and press Make my voice to try again.');
  } else if (voiceSample && state.neuralReady && !IS_PHONE) buildNeural(true);
  go(routeFromHash(), true);
})();
