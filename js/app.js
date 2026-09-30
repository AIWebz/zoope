/* zoope app — wires the UI to the on-device engine, avatar and voice modules. */
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
  }

  /* ----------------------------- 1. connect ---------------------------- */
  function renderPlatforms() {
    document.querySelectorAll('.platform').forEach(function (el) {
      var key = el.dataset.platform, acct = state.platforms[key];
      var input = el.querySelector('.acct'), btn = el.querySelector('.connect-btn');
      var status = el.querySelector('.status');
      el.classList.toggle('connected', !!acct);
      if (acct) {
        input.value = acct; input.disabled = true;
        btn.textContent = 'Disconnect'; btn.classList.add('ghost');
        if (!status) { status = document.createElement('div'); status.className = 'status'; el.insertBefore(status, btn); }
        status.textContent = '✓ Connected';
      } else {
        input.disabled = false;
        btn.textContent = 'Connect'; btn.classList.remove('ghost');
        if (status) status.remove();
      }
    });
    var sel = $('mPlatform'), cur = sel.value;
    sel.innerHTML = Object.keys(PLATFORMS).map(function (k) {
      return '<option value="' + k + '"' + (state.platforms[k] ? '' : ' disabled') + '>' + PLATFORMS[k].name + (state.platforms[k] ? '' : ' (not connected)') + '</option>';
    }).join('');
    var firstOk = Object.keys(PLATFORMS).filter(function (k) { return state.platforms[k]; })[0];
    sel.value = state.platforms[cur] ? cur : (firstOk || 'zoom');
  }

  document.querySelectorAll('.platform').forEach(function (el) {
    el.querySelector('.connect-btn').addEventListener('click', function () {
      var key = el.dataset.platform, input = el.querySelector('.acct');
      if (state.platforms[key]) {
        delete state.platforms[key];
      } else {
        var v = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { input.focus(); input.style.borderColor = 'var(--danger)'; return; }
        input.style.borderColor = '';
        state.platforms[key] = v;
      }
      save(); renderPlatforms();
    });
  });

  /* ------------------------ 2. zoope asks your names -------------------- */
  var chat = $('setupChat');
  function bot(text) { addMsg('bot', 'zoope', text); }
  function me(text) { addMsg('me', 'You', text); }
  function addMsg(cls, who, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = '<span class="who">' + esc(who) + '</span>' + esc(text);
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
    $('nameChips').innerHTML = p.names.length ? '<span class="muted small">zoope responds to:</span> ' + p.names.map(function (n, i) {
      return '<span class="chip">' + esc(n) + (n === p.preferred ? ' ★' : '') + ' <button data-i="' + i + '" title="Remove">×</button></span>';
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
    name: function () { bot('Hi! I\'m zoope 👋 I\'ll go to meetings as you. First — what\'s your full name?'); },
    nicknames: function () {
      bot('Nice to meet you, ' + state.profile.fullName.split(' ')[0] + '! What names do people call you by? Include nicknames, short names or initials — separate them with commas.');
    },
    preferred: function () { bot('Got it: ' + state.profile.names.join(', ') + '. Which one should I introduce myself with?'); },
    more: function () { bot('Any other names people use for you — maybe a work nickname or how your family says it? Type "no" if that\'s all.'); },
    done: function () {
      bot('Perfect. In meetings I\'ll answer when someone says ' + state.profile.names.join(', ') + ' and introduce myself as ' + state.profile.preferred + '. Type "change" anytime to update your names.');
    }
  };

  function handleChat(text) {
    var p = state.profile, step = state.chatStep;
    me(text);
    if (/^change\b/i.test(text)) {
      p.names = []; p.preferred = ''; state.chatStep = 'name';
      save(); renderChips(); ASK.name(); return;
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
        bot('Added! Anything else?');
        save(); renderChips(); return;
      }
    } else {
      bot('I\'ve got your names. Type "change" to redo them, or scroll down to scan your face and voice.');
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
      bot('Welcome back, ' + (state.profile.preferred || state.profile.fullName) + '!');
      ASK.done();
    } else {
      if (state.chatStep !== 'name' && !state.profile.fullName) state.chatStep = 'name';
      ASK[state.chatStep]();
    }
  }

  /* ------------------------ 3. face & voice scan ------------------------ */
  var stream = null, stopPreview = null;
  var cam = $('cam');

  function refreshAvatarBox() {
    if (stopPreview) stopPreview();
    stopPreview = null;
    var info = [];
    if (state.face) {
      stopPreview = ZoopeAvatar.animate($('avatarCanvas'), state.face, function () { return previewLevel; });
      info.push(state.face.kind === 'mesh' ? 'Photo-real face (478-point mesh)' : 'Cartoon face');
    } else {
      ZoopeAvatar.draw($('avatarCanvas'), null);
    }
    if (state.voice && state.voice.ok) {
      var sp = ZoopeVoice.synthParams(state.voice);
      info.push('Voice: ' + state.voice.pitchHz + ' Hz, ' + state.voice.register + ' register → pitch ' + sp.pitch + ', rate ' + sp.rate);
    }
    $('avatarInfo').textContent = info.length ? info.join(' · ') : 'No avatar yet';
    $('testVoice').disabled = !state.face;
  }
  var previewLevel = 0;

  $('startCam').addEventListener('click', function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('scanStatus').textContent = 'This browser cannot access the camera.'; return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true }).then(function (s) {
      stream = s;
      cam.srcObject = s;
      cam.play();
      $('camPlaceholder').classList.add('hidden');
      $('scanFace').disabled = false;
      $('recordVoice').disabled = false;
      $('startAlphabet').disabled = false;
      $('alphaStatus').textContent = 'Ready. Press “Start alphabet”.';
      $('startCam').textContent = 'Camera & mic on';
      $('startCam').disabled = true;
      $('scanStatus').textContent = 'Put your face inside the oval, in good light.';
    }).catch(function (err) {
      $('scanStatus').textContent = 'Could not open camera/mic: ' + err.message;
    });
  });

  $('scanFace').addEventListener('click', function () {
    var line = $('scanLine');
    line.classList.add('on');
    $('scanFace').disabled = true;
    $('scanStatus').textContent = 'Loading the face model (first time only)…';
    ZoopeFaceMesh.load().then(function () {
      $('scanStatus').textContent = 'Scanning your face… hold still and look at the camera.';
      return new Promise(function (res) { setTimeout(res, 400); });
    }).then(function () {
      // take a few scans and keep the one where the face fills the frame best
      var tries = [0, 1, 2].map(function (i) {
        return new Promise(function (res) { setTimeout(res, i * 300); }).then(function () { return ZoopeFaceMesh.scan(cam); });
      });
      return Promise.all(tries);
    }).then(function (faces) {
      var best = faces.filter(Boolean).sort(function (a, b) { return b.confidence - a.confidence; })[0];
      if (!best) throw new Error('noface');
      finishScan(best, 'Face cloned from 478 points! Now clone your voice below.');
    }).catch(function (err) {
      if (err && err.message === 'noface') {
        line.classList.remove('on');
        $('scanFace').disabled = false;
        $('scanStatus').textContent = 'I couldn\'t find your face. Look straight at the camera, inside the oval, in good light, then try again.';
        return;
      }
      // face model unavailable: fall back to the cartoon avatar
      var fallback = ZoopeAvatar.scanFace(cam);
      finishScan(fallback, 'The face model couldn\'t load here, so I made a cartoon avatar instead.');
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
    $('scanStatus').textContent = 'Listening… read the sentence out loud.';
    ZoopeVoice.scanVoice(stream, 6, function (l) { $('meterFill').style.width = (l * 100) + '%'; })
      .then(function (v) {
        $('recordVoice').disabled = false;
        if (!v.ok) { $('scanStatus').textContent = v.reason; return; }
        state.voice = v;
        save();
        refreshAvatarBox();
        $('scanStatus').textContent = 'Voice captured! Press “Hear my AI voice”.';
      })
      .catch(function (err) { $('recordVoice').disabled = false; $('scanStatus').textContent = err.message; });
  });

  $('testVoice').addEventListener('click', function () {
    var n = state.profile.preferred || 'your zoope';
    speakAs('Hi everyone, ' + n + ' here. Happy to share a quick update.', function (l) { previewLevel = l; });
  });

  /* ------------------------ alphabet voice clone ------------------------ */
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
  function rebuildClone() { cloneVoice = hasClone() ? new ZoopeVoiceClone.Voice(clips) : null; }

  function renderAlphabet(current) {
    $('alphaGrid').innerHTML = LETTERS.map(function (L) {
      return '<button data-letter="' + L + '" class="' + (clips[L] ? 'done' : '') + (L === current ? ' current' : '') + '">' + L + '</button>';
    }).join('');
    var n = Object.keys(clips).length;
    $('testClone').disabled = !hasClone();
    if (!alphaRun) {
      $('alphaStatus').textContent = n === 26 ? 'All 26 letters recorded. Your cloned voice is ready.'
        : n ? n + ' of 26 letters recorded' + (hasClone() ? '. Enough to speak, but more letters sound better.' : '. Record at least 20 to use your cloned voice.')
        : (stream ? 'Ready. Press “Start alphabet”.' : 'Turn on the camera & mic above to start.');
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
      $('alphaStatus').textContent = 'Say “' + L + '” now…';
      ZoopeVoiceClone.recordLetter(stream, function (l) { $('meterFill').style.width = (l * 100) + '%'; }).then(function (clip) {
        $('bigLetter').classList.remove('listening');
        if (run.stop) return end();
        if (!clip || clip.length < ZoopeVoiceClone.RATE * 0.15) {
          $('alphaStatus').textContent = 'I didn\'t catch “' + L + '”. Let\'s try again.';
          return setTimeout(next, 900);
        }
        clips[L] = clip;
        i++;
        setTimeout(next, 250);
      }).catch(function (err) { $('alphaStatus').textContent = err.message; end(); });
    })();

    function end() {
      $('bigLetter').classList.remove('listening');
      alphaRun = null;
      $('startAlphabet').disabled = false;
      $('stopAlphabet').disabled = true;
      var stored = saveClips();
      rebuildClone();
      renderAlphabet(null);
      if (!stored) $('alphaStatus').textContent += ' (Browser storage is full, so the recording only lasts until you close this page.)';
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

  /* ---------------------------- 4. knowledge ---------------------------- */
  $('knowledge').value = state.profile.knowledge || '';
  $('saveKnowledge').addEventListener('click', function () {
    state.profile.knowledge = $('knowledge').value.trim();
    save();
    var n = new ZoopeKnowledgeBase(state.profile.knowledge).sentences.length;
    $('knowledgeSaved').textContent = 'Saved — zoope learned ' + n + ' fact' + (n === 1 ? '' : 's') + '.';
  });

  /* ----------------------------- 5. meetings ---------------------------- */
  function renderMeetings() {
    var list = $('meetingList');
    if (!state.meetings.length) { list.innerHTML = '<div class="empty">No meetings yet. Add one above.</div>'; return; }
    list.innerHTML = state.meetings.slice().sort(function (a, b) { return a.time.localeCompare(b.time); }).map(function (m) {
      var p = PLATFORMS[m.platform];
      return '<div class="meeting" data-id="' + m.id + '">' +
        '<img src="' + p.img + '" alt="' + p.name + '">' +
        '<div class="info"><b>' + esc(m.title) + '</b><span class="muted small">' + p.name + ' · ' +
          esc(new Date(m.time).toLocaleString()) + (m.people.length ? ' · with ' + esc(m.people.join(', ')) : '') + '</span></div>' +
        '<span class="badge ' + (m.confirmed ? 'confirmed' : 'pending') + '">' + (m.confirmed ? 'zoope will attend' : 'Needs your OK') + '</span>' +
        '<div class="actions">' +
          (m.confirmed
            ? '<button class="btn" data-act="join">Join now</button><button class="btn ghost" data-act="unconfirm">Cancel</button>'
            : '<button class="btn ok" data-act="confirm">Confirm</button>') +
          (m.link ? '<a class="btn ghost" href="' + esc(m.link) + '" target="_blank" rel="noopener">Open link</a>' : '') +
          '<button class="btn ghost" data-act="delete" title="Delete">🗑</button>' +
        '</div></div>';
    }).join('');
  }

  $('meetingForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var platform = $('mPlatform').value;
    if (!state.platforms[platform]) { alert('Connect ' + PLATFORMS[platform].name + ' first (step 1).'); return; }
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
    e.target.reset(); renderPlatforms();
  });

  $('meetingList').addEventListener('click', function (e) {
    var act = e.target.dataset.act;
    if (!act) return;
    var id = e.target.closest('.meeting').dataset.id;
    var m = state.meetings.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    if (act === 'confirm') {
      var missing = readinessProblems();
      var msg = 'Send your zoope avatar to “' + m.title + '” on ' + PLATFORMS[m.platform].name + '?\n\n' +
        'It will speak as ' + (state.profile.preferred || 'you') + ' using your avatar and voice.' +
        (missing.length ? '\n\nHeads up: ' + missing.join('; ') + '.' : '');
      if (confirm(msg)) { m.confirmed = true; m.joined = false; }
    } else if (act === 'unconfirm') {
      m.confirmed = false;
    } else if (act === 'delete') {
      if (confirm('Delete “' + m.title + '”?')) state.meetings = state.meetings.filter(function (x) { return x.id !== id; });
    } else if (act === 'join') {
      joinMeeting(m);
    }
    save(); renderMeetings();
  });

  function readinessProblems() {
    var out = [];
    if (!state.profile.names.length) out.push('you haven\'t told zoope your names yet');
    if (!state.face) out.push('your face hasn\'t been scanned');
    if (!state.voice && !hasClone()) out.push('your voice hasn\'t been recorded');
    return out;
  }

  // Auto-join confirmed meetings when their time comes (while this page is open).
  setInterval(function () {
    var now = Date.now();
    state.meetings.forEach(function (m) {
      var t = new Date(m.time).getTime();
      if (m.confirmed && !m.joined && now >= t && now - t < 15 * 60 * 1000 && !room) {
        joinMeeting(m);
      }
    });
  }, 15000);

  /* ---------------------------- meeting room ---------------------------- */
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
      demoTimer: null
    };

    $('room').classList.remove('hidden');
    $('summary').classList.add('hidden');
    $('roomTitle').textContent = m.title + ' — ' + PLATFORMS[m.platform].name;
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
    $('roomAvatarName').textContent = (profile.preferred || 'You') + ' (zoope)';
    $('speaker').innerHTML = people.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join('');
    $('transcript').innerHTML = '';
    $('decisionLog').innerHTML = '';
    room.stopAnim = ZoopeAvatar.animate($('roomAvatar'), state.face, function () { return room ? room.level : 0; });

    sys('zoope joined as ' + (profile.preferred || 'you') + '. (Meeting room preview — audio from the room comes from the box below or the 🎤 button.)');
    var problems = readinessProblems();
    if (problems.length) sys('Heads up: ' + problems.join('; ') + '.');
    aiSay(room.engine.greetOnJoin());
    $('room').scrollIntoView({ behavior: 'smooth' });
  }

  function sys(text) { line('sys', null, text); }
  function line(cls, who, text) {
    var d = document.createElement('div');
    d.className = 'line ' + (cls || '');
    d.innerHTML = who ? '<b>' + esc(who) + ':</b> ' + esc(text) : esc(text);
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
        line('ai', r.engine.preferred + ' (zoope)', text);
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
    el.className = 'decision' + (d.speak ? ' speak' : '');
    el.innerHTML = '<div><b>' + esc(d.speaker) + '</b>: “' + esc(d.text) + '”</div>' +
      '<div>Intent: ' + esc(d.intent) + ' · <span class="score">score ' + d.score.toFixed(2) + '</span> → ' + (d.speak ? '<b>respond</b>' : 'stay quiet') + '</div>' +
      '<div class="muted">' + d.reasons.map(esc).join(' · ') + '</div>';
    $('decisionLog').prepend(el);
  }

  $('sayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('sayInput').value.trim();
    if (!v) return;
    $('sayInput').value = '';
    hear($('speaker').value, v);
  });

  $('listenBtn').addEventListener('click', function () {
    if (!room) return;
    if (room.listener) { room.listener.stop(); room.listener = null; $('listenBtn').textContent = '🎤 Listen to room'; return; }
    var who = room.people[0];
    room.listener = ZoopeVoice.listen(function (text) {
      if (window.speechSynthesis && speechSynthesis.speaking) return; // don't hear ourselves
      hear($('speaker').value || who, text);
    }, function (on) { $('listenBtn').textContent = on ? '⏹ Stop listening' : '🎤 Listen to room'; if (!on && room) room.listener = null; });
    if (!room.listener) sys('Live listening needs a browser with speech recognition (e.g. Chrome or Edge). You can still type what people say.');
  });

  $('demoBtn').addEventListener('click', startDemo);
  $('demoBtnTop').addEventListener('click', startDemo);

  function startDemo() {
    var demoMeeting = room ? room.meeting : null;
    var people = ['Sam', 'Priya', 'Jordan'];
    if (!demoMeeting || !demoMeeting.demo) {
      demoMeeting = { id: 'demo', demo: true, title: 'Weekly sync (demo)', platform: Object.keys(state.platforms)[0] || 'zoom', people: people, time: new Date().toISOString() };
    }
    joinMeeting(demoMeeting, { sampleKnowledge: true });
    if (!state.profile.knowledge) sys('No knowledge saved yet — using sample notes for this demo.');
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
    if (r.stopAnim) r.stopAnim();
    if (window.speechSynthesis) speechSynthesis.cancel();
    $('listenBtn').textContent = '🎤 Listen to room';
    $('room').classList.add('hidden');
    if (showSummary) renderSummary(r);
  }

  function renderSummary(r) {
    var s = r.engine.summary();
    var list = function (items, fmt) { return items.length ? '<ul>' + items.map(fmt).join('') + '</ul>' : '<p class="muted">None</p>'; };
    var html = '<p><b>' + esc(r.meeting.title) + '</b> · ' + s.turns + ' lines · zoope spoke ' + s.spoke + ' time(s) and stayed quiet ' + s.stayedQuiet + ' time(s).</p>' +
      '<h3>Topics</h3><p>' + (s.topics.length ? s.topics.map(esc).join(', ') : '—') + '</p>' +
      '<h3>Action items for you</h3>' + list(s.actionItems, function (a) { return '<li>' + esc(a.text) + ' <span class="muted">— from ' + esc(a.from) + (a.due ? ', ' + esc(a.due) : '') + '</span></li>'; }) +
      '<h3>Questions zoope promised to follow up on</h3>' + list(s.followUps, function (f) { return '<li>' + esc(f.text) + ' <span class="muted">— ' + esc(f.from) + '</span></li>'; });
    if (s.unknownNames.length) {
      html += '<h3>Is this you?</h3><p>Someone in the meeting was called ' + s.unknownNames.map(function (n) { return '“' + esc(n) + '”'; }).join(', ') +
        '. Do people call you that?</p>' + s.unknownNames.map(function (n) {
          return '<button class="btn ghost" data-addname="' + esc(n) + '">Yes, add “' + esc(n) + '” to my names</button> ';
        }).join('');
    }
    $('summaryBody').innerHTML = html;
    $('summary').classList.remove('hidden');
    $('summary').scrollIntoView({ behavior: 'smooth' });
  }

  $('summaryBody').addEventListener('click', function (e) {
    var n = e.target.dataset.addname;
    if (!n) return;
    addNames([n]); save(); renderChips();
    e.target.disabled = true; e.target.textContent = '✓ Added “' + n + '”';
    bot('Thanks! I\'ll also answer to “' + n + '” from now on.');
  });

  /* ------------------------------- init -------------------------------- */
  renderPlatforms();
  renderChips();
  startChat();
  refreshAvatarBox();
  rebuildClone();
  renderAlphabet(null);
  renderMeetings();
})();
