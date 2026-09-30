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
    var def = { platforms: {}, profile: { fullName: '', names: [], preferred: '', knowledge: '' }, face: null, voice: null, meetings: [], chatStep: 'name' };
    try {
      var raw = localStorage.getItem('zoope');
      if (raw) { var s = JSON.parse(raw); for (var k in def) if (!(k in s)) s[k] = def[k]; return s; }
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
      el.querySelector('.platform-sub').textContent = acct || 'Not connected';
      input.disabled = !!acct;
      if (acct) input.value = acct;
      btn.textContent = acct ? 'Disconnect' : 'Connect';
      btn.className = 'btn connect-btn ' + (acct ? 'btn-ghost' : 'btn-secondary');
    });
    var sel = $('mPlatform'), cur = sel.value;
    sel.innerHTML = Object.keys(PLATFORMS).map(function (k) {
      return '<option value="' + k + '"' + (state.platforms[k] ? '' : ' disabled') + '>' + PLATFORMS[k].name + (state.platforms[k] ? '' : ' (not connected)') + '</option>';
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
        toast(PLATFORMS[key].name + ' disconnected');
      } else {
        var v = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { input.classList.add('invalid'); input.focus(); return; }
        input.classList.remove('invalid');
        state.platforms[key] = v;
        toast(PLATFORMS[key].name + ' connected');
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

  /* ------------------------------ knowledge ------------------------------ */
  function factCount(text) { return new ZoopeKnowledgeBase(text).sentences.length; }
  function renderKnowledgeStatus(saved) {
    var n = factCount(state.profile.knowledge || '');
    $('knowledgeSaved').textContent = saved ? 'Saved · ' + n + ' fact' + (n === 1 ? '' : 's')
      : (n ? n + ' fact' + (n === 1 ? '' : 's') + ' saved' : 'No notes yet');
  }
  $('knowledge').value = state.profile.knowledge || '';
  $('knowledge').addEventListener('input', function () {
    var dirty = $('knowledge').value.trim() !== (state.profile.knowledge || '');
    $('knowledgeSaved').textContent = dirty ? 'Unsaved changes' : $('knowledgeSaved').textContent;
    $('saveKnowledge').className = 'btn ' + (dirty ? 'btn-primary' : 'btn-secondary');
  });
  $('saveKnowledge').addEventListener('click', function () {
    state.profile.knowledge = $('knowledge').value.trim();
    save();
    renderKnowledgeStatus(true);
    $('saveKnowledge').className = 'btn btn-secondary';
    toast('Knowledge saved');
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
    if (state.face) {
      stopPreview = ZoopeAvatar.animate($('avatarCanvas'), state.face, function () { return previewLevel; });
    } else {
      ZoopeAvatar.draw($('avatarCanvas'), null);
    }
    var mesh = state.face && state.face.kind === 'mesh';
    $('avatarInfo').textContent = state.face ? (mesh ? 'Photo-real · 478 points' : 'Illustrated') : 'None yet';
    $('faceBadge').textContent = state.face ? (mesh ? 'Photo-real' : 'Illustrated') : 'Not scanned';
    $('faceBadge').className = 'pill ' + (state.face ? 'pill-green pill-dot' : '');
    $('testVoice').disabled = !state.face;
  }

  $('startCam').addEventListener('click', function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This browser can\'t access a camera.', 'error'); return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true }).then(function (s) {
      stream = s;
      cam.srcObject = s;
      cam.play();
      $('camPlaceholder').classList.add('hidden');
      ['scanFace', 'recordVoice', 'startAlphabet'].forEach(function (id) { $(id).disabled = false; });
      setStartCamLabel(true);
      $('scanStatus').textContent = 'Fit your face inside the oval, in good light, then scan.';
      renderAlphabet(null);
    }).catch(function (err) {
      toast('Couldn\'t open the camera or mic: ' + err.message, 'error');
    });
  });

  // Turns the camera and mic off (used when leaving the page).
  function stopCamera() {
    if (alphaRun) alphaRun.stop = true;
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    cam.srcObject = null;
    $('camPlaceholder').classList.remove('hidden');
    setStartCamLabel(false);
    ['scanFace', 'recordVoice', 'startAlphabet'].forEach(function (id) { $(id).disabled = true; });
    renderAlphabet(null);
  }

  $('scanFace').addEventListener('click', function () {
    var line = $('scanLine');
    line.classList.add('on');
    $('scanFace').disabled = true;
    $('scanStatus').textContent = 'Loading the face model…';
    ZoopeFaceMesh.load().then(function () {
      $('scanStatus').textContent = 'Scanning. Hold still and look at the camera.';
      return new Promise(function (res) { setTimeout(res, 400); });
    }).then(function () {
      // take a few scans and keep the one where the face fills the frame best
      return Promise.all([0, 1, 2].map(function (i) {
        return new Promise(function (res) { setTimeout(res, i * 300); }).then(function () { return ZoopeFaceMesh.scan(cam); });
      }));
    }).then(function (faces) {
      var best = faces.filter(Boolean).sort(function (a, b) { return b.confidence - a.confidence; })[0];
      if (!best) throw new Error('noface');
      finishScan(best, 'Face captured from 478 points. Next, record your voice below.');
      toast('Face scanned');
    }).catch(function (err) {
      if (err && err.message === 'noface') {
        line.classList.remove('on');
        $('scanFace').disabled = false;
        $('scanStatus').textContent = 'No face found. Look straight at the camera, inside the oval, in good light.';
        return;
      }
      // face model unavailable: fall back to the illustrated avatar
      finishScan(ZoopeAvatar.scanFace(cam), 'The face model couldn\'t load, so zoope made an illustrated avatar instead.');
    });

    function finishScan(face, msg) {
      line.classList.remove('on');
      $('scanFace').disabled = false;
      state.face = face;
      save();
      refreshAvatarBox();
      $('scanStatus').textContent = msg;
    }
  });

  $('recordVoice').addEventListener('click', function () {
    if (!stream) return;
    $('recordVoice').disabled = true;
    $('recordVoice').textContent = 'Listening…';
    ZoopeVoice.scanVoice(stream, 6, function (l) { $('meterFill').style.width = (l * 100) + '%'; })
      .then(function (v) {
        $('recordVoice').disabled = false;
        $('recordVoice').textContent = 'Record 6s';
        if (!v.ok) { toast(v.reason, 'error'); return; }
        state.voice = v;
        save();
        toast('Backup voice tuned to ' + v.pitchHz + ' Hz');
      })
      .catch(function (err) { $('recordVoice').disabled = false; $('recordVoice').textContent = 'Record 6s'; toast(err.message, 'error'); });
  });

  $('testVoice').addEventListener('click', function () {
    var n = state.profile.preferred || 'your zoope';
    speakAs('Hi everyone, ' + n + ' here. Happy to share a quick update.', function (l) { previewLevel = l; });
  });

  /* ------------------------- alphabet voice clone ------------------------- */
  var LETTERS = ZoopeVoiceClone.LETTERS;
  var clips = loadClips(), cloneVoice = null, alphaRun = null;

  function loadClips() {
    var out = {};
    try {
      var raw = JSON.parse(localStorage.getItem('zoope-voiceclone') || '{}');
      for (var L in raw) out[L] = ZoopeVoiceClone.decode(raw[L]);
    } catch (e) { /* storage unavailable or corrupt */ }
    return out;
  }
  function saveClips() {
    var raw = {};
    for (var L in clips) raw[L] = ZoopeVoiceClone.encode(clips[L]);
    try { localStorage.setItem('zoope-voiceclone', JSON.stringify(raw)); return true; } catch (e) { return false; }
  }
  function hasClone() { return Object.keys(clips).length >= 20; }
  function rebuildClone() { cloneVoice = hasClone() ? new ZoopeVoiceClone.Voice(clips) : null; renderChecklist(); }

  function renderAlphabet(current) {
    $('alphaGrid').innerHTML = LETTERS.map(function (L) {
      var cls = (clips[L] ? 'done' : '') + (L === current ? ' current' : '');
      return '<button type="button" data-letter="' + L + '" class="' + cls + '" aria-label="Letter ' + L + (clips[L] ? ', recorded' : '') + '">' + L + '</button>';
    }).join('');
    var n = Object.keys(clips).length;
    $('voiceBadge').textContent = n + ' / 26';
    $('voiceBadge').className = 'pill ' + (n === 26 ? 'pill-green pill-dot' : hasClone() ? 'pill-accent' : '');
    $('testClone').disabled = !hasClone();
    if (!alphaRun) {
      $('startAlphabet').lastChild.textContent = n && n < 26 ? 'Continue alphabet' : n === 26 ? 'Record again' : 'Record alphabet';
      $('alphaStatus').textContent = n === 26 ? 'All 26 letters recorded. Your cloned voice is ready.'
        : n ? n + ' of 26 letters recorded. ' + (hasClone() ? 'Enough to speak; more letters sound better.' : 'Record at least 20 to use your cloned voice.')
        : (stream ? 'Ready when you are.' : 'Enable the camera & mic to start.');
    }
  }

  function runAlphabet(list) {
    if (!stream || alphaRun) return;
    var run = alphaRun = { stop: false };
    $('startAlphabet').disabled = true;
    $('stopAlphabet').disabled = false;
    var i = 0;
    (function next() {
      if (run.stop || i >= list.length) return end();
      var L = list[i];
      $('bigLetter').textContent = L;
      $('bigLetter').classList.add('listening');
      renderAlphabet(L);
      $('alphaStatus').textContent = 'Say “' + L + '” now.';
      ZoopeVoiceClone.recordLetter(stream, function (l) { $('meterFill').style.width = (l * 100) + '%'; }).then(function (clip) {
        $('bigLetter').classList.remove('listening');
        if (run.stop) return end();
        if (!clip || clip.length < ZoopeVoiceClone.RATE * 0.15) {
          $('alphaStatus').textContent = 'Didn\'t catch “' + L + '”. Trying again.';
          return setTimeout(next, 900);
        }
        clips[L] = clip;
        i++;
        setTimeout(next, 250);
      }).catch(function (err) { toast(err.message, 'error'); end(); });
    })();

    function end() {
      $('bigLetter').classList.remove('listening');
      alphaRun = null;
      $('startAlphabet').disabled = !stream;
      $('stopAlphabet').disabled = true;
      var stored = saveClips();
      rebuildClone();
      renderAlphabet(null);
      if (!stored) toast('Browser storage is full, so the recording lasts only until you close this tab.', 'error');
      else if (hasClone()) toast('Voice clone updated');
    }
  }

  $('startAlphabet').addEventListener('click', function () {
    var todo = LETTERS.filter(function (L) { return !clips[L]; });
    runAlphabet(todo.length ? todo : LETTERS.slice());
  });
  $('stopAlphabet').addEventListener('click', function () { if (alphaRun) alphaRun.stop = true; });
  $('alphaGrid').addEventListener('click', function (e) {
    var L = e.target.dataset.letter;
    if (!L || alphaRun) return;
    if (!stream) { if (clips[L]) ZoopeVoiceClone.playClip(clips[L]); return; }
    runAlphabet([L]);
  });
  $('testClone').addEventListener('click', function () {
    if (!cloneVoice) return;
    var n = state.profile.preferred || 'your zoope';
    cloneVoice.speak('Hi everyone, ' + n + ' here. Happy to share a quick update.', function (l) { previewLevel = l; });
  });
  $('voiceMode').value = state.voiceMode || 'clone';
  $('voiceMode').addEventListener('change', function () { state.voiceMode = $('voiceMode').value; save(); });

  // Speaks as the user: cloned voice when available and chosen, otherwise the tuned browser voice.
  function speakAs(text, onLevel) {
    if (cloneVoice && (state.voiceMode || 'clone') === 'clone') return cloneVoice.speak(text, onLevel);
    return ZoopeVoice.speak(text, state.voice, onLevel);
  }

  /* ------------------------------ checklist ------------------------------ */
  function checklistItems() {
    return [
      { label: 'Connect a meeting app', done: Object.keys(state.platforms).length > 0, route: 'setup' },
      { label: 'Add your names', done: state.profile.names.length > 0 && state.chatStep === 'done', route: 'setup' },
      { label: 'Write knowledge', done: !!state.profile.knowledge, route: 'setup' },
      { label: 'Scan your face', done: !!state.face, route: 'clone' },
      { label: 'Clone your voice', done: hasClone(), route: 'clone' },
      { label: 'Confirm a meeting', done: state.meetings.some(function (m) { return m.confirmed; }), route: 'meetings' }
    ];
  }
  function renderChecklist() {
    if (typeof clips === 'undefined') return; // called during start-up before the voice bank loads
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
        '<h3>No meetings yet</h3><p>Add a meeting from a connected app. zoope joins only after you confirm it.</p>' +
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
      $('meetingError').innerHTML = 'Connect ' + PLATFORMS[platform].name + ' first in <a href="#/setup"><u>Setup</u></a>.';
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
        body: 'zoope will join on ' + PLATFORMS[m.platform].name + ' at ' + esc(fmtDate(m.time).time || 'the start time') +
          ' and speak as <b>' + esc(state.profile.preferred || 'you') + '</b> with your avatar and voice.' +
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
    if (!state.face) out.push('scan your face');
    if (!state.voice && !hasClone()) out.push('record your voice');
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
    if (room) leaveRoom(false);
    m.joined = true; save();
    var people = m.people.length ? m.people : ['Sam', 'Priya', 'Jordan'];
    var profile = JSON.parse(JSON.stringify(state.profile));
    if (!profile.names.length) { profile.names = ['you']; profile.preferred = 'You'; }
    if (opts.sampleKnowledge && !profile.knowledge) profile.knowledge = SAMPLE_KNOWLEDGE;

    room = {
      meeting: m,
      people: people,
      engine: new ZoopeEngine(profile, { attendees: people }),
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
    room.stopAnim = ZoopeAvatar.animate($('roomAvatar'), state.face, function () { return room ? room.level : 0; });

    sys('Joined as ' + (profile.preferred || 'you') + '. Type what people say below, or use Listen.');
    var problems = readinessProblems();
    if (problems.length) sys('Not ready yet: ' + problems.join('; ') + '.');
    aiSay(room.engine.greetOnJoin());
    if (currentRoute !== room.page) navigate(room.page);
    else setTimeout(function () { $('room').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
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

  function aiSay(text) {
    var r = room;
    r.queue = r.queue.then(function () {
      if (room !== r) return;
      return new Promise(function (res) { setTimeout(res, 600); }).then(function () { // natural pause before speaking
        if (room !== r) return;
        line('ai', r.engine.preferred + ' · zoope', text);
        highlight(null, true);
        return speakAs(text, function (l) { r.level = l; });
      }).then(function () { highlight(null, false); r.level = 0; });
    });
    return r.queue;
  }

  function hear(speaker, text) {
    if (!room || !text) return;
    line('', speaker, text);
    highlight(speaker, true);
    setTimeout(function () { highlight(speaker, false); }, 900);
    var d = room.engine.hear(speaker, text);
    logDecision(d);
    if (d.speak) aiSay(d.reply);
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
    if (!state.profile.knowledge) sys('No knowledge saved, so this demo uses sample notes.');
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
    setListenLabel(false);
    $('room').classList.add('hidden');
    if (r.page === 'demo') {
      $('demoIntro').classList.remove('hidden');
      $('demoBtnTop').classList.remove('hidden');
      $('demoBtnTop').querySelector('span').textContent = 'Run again';
    }
    if (showSummary) renderSummary(r);
    else $('summary').classList.add('hidden');
  }

  function renderSummary(r) {
    var s = r.engine.summary();
    function section(title, items, fmt) {
      return '<div class="summary-section"><h3>' + title + '</h3>' +
        (items.length ? '<ul>' + items.map(fmt).join('') + '</ul>' : '<p class="summary-empty">None</p>') + '</div>';
    }
    var html = '<dl class="summary-stats">' +
      '<div><dt>Lines</dt><dd>' + s.turns + '</dd></div>' +
      '<div><dt>zoope replied</dt><dd>' + s.spoke + '</dd></div>' +
      '<div><dt>Stayed quiet</dt><dd>' + s.stayedQuiet + '</dd></div>' +
      '<div><dt>Action items</dt><dd>' + s.actionItems.length + '</dd></div></dl>';
    if (s.unknownNames.length) {
      html += s.unknownNames.map(function (n) {
        return '<div class="summary-section name-ask"><p>Someone was called <b>“' + esc(n) + '”</b>. Do people call you that?</p>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-addname="' + esc(n) + '">Add to my names</button></div>';
      }).join('');
    }
    html += section('Action items', s.actionItems, function (a) { return '<li><div>' + esc(a.text) + ' <span>· ' + esc(a.from) + (a.due ? ', ' + esc(a.due) : '') + '</span></div></li>'; }) +
      section('Follow-ups zoope promised', s.followUps, function (f) { return '<li><div>' + esc(f.text) + ' <span>· ' + esc(f.from) + '</span></div></li>'; }) +
      '<div class="summary-section"><h3>Topics</h3>' + (s.topics.length ? '<div class="topic-row">' + s.topics.map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join('') + '</div>' : '<p class="summary-empty">None</p>') + '</div>';
    $('summaryBody').innerHTML = html;
    $('summary').classList.remove('hidden');
    $('summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('summaryBody').addEventListener('click', function (e) {
    var n = e.target.dataset.addname;
    if (!n) return;
    addNames([n]); save(); renderChips();
    e.target.disabled = true; e.target.textContent = 'Added';
    bot('Thanks. I\'ll also answer to “' + n + '” from now on.');
    toast('“' + n + '” added to your names');
  });

  /* ------------------------------- routing ------------------------------- */
  var ROUTES = ['home', 'setup', 'clone', 'demo', 'meetings'];
  var TITLES = { home: 'zoope', setup: 'Setup', clone: 'Face & voice', demo: 'Demo meeting', meetings: 'Meetings' };
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
  renderKnowledgeStatus(false);
  refreshAvatarBox();
  rebuildClone();
  renderAlphabet(null);
  renderMeetings();
  go(routeFromHash(), true);
})();
