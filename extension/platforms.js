/*
 * zoope extension: how to drive each meeting web app.
 *
 * Controls are found by their accessible names and visible text ("Join now",
 * "Leave call", ...) rather than by class names, which change often. Each
 * adapter knows how to get through the pre-join screen, whether the avatar is
 * waiting in a lobby or in the call, how to turn on captions, how to read them,
 * how to post in the chat and how to leave.
 */
(() => {
  if (window.ZoopePlatforms) return;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  function label(el) {
    return norm(el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('title') || el.innerText || el.textContent || el.value);
  }
  function visible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  const CLICKABLE = 'button, [role="button"], a[href], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"], [role="tab"], input[type="button"], input[type="submit"]';
  /* The first visible, enabled control whose name matches one of the patterns (in pattern order). */
  function find(patterns, root) {
    const els = Array.from((root || document).querySelectorAll(CLICKABLE));
    for (const re of patterns) {
      for (const el of els) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (re.test(label(el)) && visible(el)) return el;
      }
    }
    return null;
  }
  function click(el) {
    if (!el) return false;
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
    return true;
  }
  /* Sets an input's value in a way React/Angular notice. */
  function setValue(input, value) {
    input.focus();
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function typeInto(el, text) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    } else setValue(el, text);
  }
  function pressEnter(el) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  function first(selector) {
    return Array.from(document.querySelectorAll(selector)).find(visible) || null;
  }
  function bodyText() { return document.body ? document.body.innerText || '' : ''; }

  /* Caption blocks that show a speaker's name above their words (Meet). */
  function blocksWithNames(region) {
    const out = [], seen = new Set();
    region.querySelectorAll('img').forEach((img) => {
      let el = img.parentElement;
      // climb to the block that holds both the name and the words
      while (el && el !== region && !(el.innerText || '').trim().includes('\n')) el = el.parentElement;
      if (!el || el === region || seen.has(el)) return;
      seen.add(el);
      const lines = el.innerText.split('\n').map(norm).filter(Boolean);
      if (lines.length < 2) return;
      out.push({ el, speaker: lines[0], text: lines.slice(1).join(' ') });
    });
    return out;
  }

  const meet = {
    id: 'meet', name: 'Google Meet',
    match: (loc) => loc.hostname === 'meet.google.com',
    nameInput: () => first('input[aria-label="Your name"], input[placeholder="Your name"], input[type="text"][aria-label*="name" i]'),
    turnOn: [/^turn on microphone/i, /^turn on camera/i],
    dismiss: [/^got it$/i, /^dismiss$/i],
    join: [/^join now$/i, /^ask to join$/i, /^join anyway$/i, /^switch here$/i, /^join here too$/i],
    inCall: () => !!find([/^leave call$/i]),
    lobby: /asking to be let in|you'll join the call when someone lets you in|someone will let you in soon/i,
    ended: /you left the meeting|you've left the meeting|you left the call|you've left the call|the call has ended|call ended|removed from the meeting|you can't join this video call|your host ended the meeting|meeting has ended/i,
    captionsOn: () => { const off = find([/^turn on captions/i]); return off ? click(off) && 'clicked' : find([/^turn off captions/i]) ? 'on' : null; },
    captions() {
      const region = first('[role="region"][aria-label*="aption" i]');
      if (!region) return [];
      const found = blocksWithNames(region);
      if (found.length) return found;
      // no avatar images: take each caption block whose text is "Name\nwords"
      const out = [];
      region.querySelectorAll(':scope > div, :scope > div > div').forEach((el) => {
        const lines = (el.innerText || '').split('\n').map(norm).filter(Boolean);
        if (lines.length >= 2 && lines[0].length <= 40 && !out.some((o) => o.el.contains(el) || el.contains(o.el))) {
          out.push({ el, speaker: lines[0], text: lines.slice(1).join(' ') });
        }
      });
      return out;
    },
    leave: [/^leave call$/i],
    leaveConfirm: [/^just leave the call$/i, /^leave call$/i],
    chat: {
      open: [/^chat with everyone$/i, /^open chat/i, /^chat$/i],
      input: () => first('textarea[aria-label*="message" i], textarea[placeholder*="message" i]'),
      send: [/^send a message$/i, /^send message$/i, /^send$/i]
    },
    // chat messages: each has a data-message-id; the sender is named on its message group
    chatMessages() {
      return Array.from(document.querySelectorAll('[data-message-id]')).map((el) => {
        const group = el.closest('[data-sender-name]');
        let speaker = group ? group.getAttribute('data-sender-name') : '';
        if (!speaker) {
          // newer layout: the group's first line is the sender's name, then the time
          let g = el.parentElement;
          for (let i = 0; g && i < 4 && !speaker; i++, g = g.parentElement) {
            const first = (g.innerText || '').split('\n').map(norm).filter(Boolean)[0];
            if (first && first !== norm(el.innerText) && first.length <= 40) speaker = first;
          }
        }
        return { el, speaker: speaker || 'Someone', text: norm(el.innerText) };
      }).filter((m) => m.text);
    }
  };

  const zoom = {
    id: 'zoom', name: 'Zoom',
    match: (loc) => /(^|\.)zoom\.us$/.test(loc.hostname),
    // invitation links open the desktop-app launcher; go straight to the web client instead
    route(loc) {
      const m = loc.pathname.match(/^\/[jsw]\/(\d{9,12})/);
      if (!m) return null;
      return 'https://app.zoom.us/wc/join/' + m[1] + loc.search;
    },
    nameInput: () => first('#input-for-name, input[placeholder*="your name" i], input[aria-label*="your name" i], input[placeholder*="name" i]'),
    turnOn: [/^join audio by computer$/i, /^join with computer audio$/i, /^start video$/i, /^unmute$/i],
    dismiss: [/^got it$/i, /^i agree$/i, /^agree$/i, /^ok$/i],
    join: [/^join$/i, /^join meeting$/i, /^join from your browser$/i, /^join from browser$/i],
    inCall: () => !!find([/^leave$/i, /^leave meeting$/i]) && !!first('#wc-footer, .footer, [class*="footer"]'),
    lobby: /waiting for the host|the host will let you in soon|please wait, the meeting host will let you in|waiting room/i,
    ended: /this meeting has been ended|the meeting has ended|you have left the meeting|you left the meeting|removed you from the meeting|meeting is ended/i,
    captionsOn: () => {
      if (first('[class*="live-transcription-subtitle"], [class*="caption-container"]')) return 'on';
      const show = find([/^show captions?$/i, /^show subtitle/i]);
      if (show) return click(show) && 'clicked';
      const cc = find([/^captions$/i, /^show captions/i, /^cc$/i, /^closed caption/i]);
      return cc ? click(cc) && 'menu' : null;
    },
    captions() {
      const items = Array.from(document.querySelectorAll('.live-transcription-subtitle__item, [class*="live-transcription-subtitle__item"], [class*="caption-line"]')).filter(visible);
      const speaker = norm((first('.speaker-active-container__video-frame .video-avatar__avatar-name, [class*="active-speaker"] [class*="name"]') || {}).innerText) || 'Someone';
      return items.map((el) => {
        const nameEl = el.querySelector('[class*="name"]');
        const who = nameEl ? norm(nameEl.innerText) : speaker;
        const text = norm(el.innerText).replace(nameEl ? norm(nameEl.innerText) : '', '').replace(/^[:\s]+/, '');
        return { el, speaker: who, text };
      });
    },
    chatMessages() {
      return Array.from(document.querySelectorAll('.chat-item__chat-info-msg, [class*="chat-message__text"]')).map((el) => {
        const item = el.closest('[class*="chat-item"], [class*="chat-message"]') || el.parentElement;
        const a = item && item.querySelector('.chat-item__sender, [class*="sender"]');
        return { el, speaker: a ? norm(a.innerText) : 'Someone', text: norm(el.innerText) };
      }).filter((m) => m.text);
    },
    leave: [/^leave$/i, /^leave meeting$/i],
    leaveConfirm: [/^leave meeting$/i],
    chat: {
      open: [/^chat$/i, /^open chat/i],
      input: () => first('.chat-box__chat-textarea, textarea[aria-label*="chat" i], textarea[placeholder*="message" i], [contenteditable="true"][aria-label*="chat" i]'),
      send: [/^send$/i]
    }
  };

  const teams = {
    id: 'teams', name: 'Microsoft Teams',
    match: (loc) => loc.hostname === 'teams.microsoft.com' || loc.hostname === 'teams.live.com',
    launcher: [/^continue on this browser$/i, /^join on the web instead$/i, /^use the web app instead$/i, /^join on the web$/i],
    nameInput: () => first('input[data-tid="prejoin-display-name-input"], input[placeholder*="type your name" i], input[placeholder*="name" i]'),
    switches() {
      // pre-join toggles: turn camera and microphone on (they carry zoope's avatar and voice)
      return Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"][role="switch"]')).filter((el) => {
        const l = label(el) || norm((el.closest('label') || {}).innerText);
        const on = el.getAttribute('aria-checked') === 'true' || el.checked === true;
        return !on && /camera|video|microphone|mic\b|audio/i.test(l) && visible(el);
      });
    },
    turnOn: [/^turn camera on$/i, /^turn on camera$/i, /^unmute$/i],
    dismiss: [/^got it$/i, /^dismiss$/i],
    join: [/^join now$/i, /^join meeting$/i],
    inCall: () => !!first('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="call-hangup"]') || !!find([/^leave$/i, /^leave \(ctrl/i, /^hang up$/i]),
    lobby: /someone in the meeting should let you in soon|we've let people in the meeting know you're waiting|waiting for someone to let you in|when the meeting starts, we'll let people know you're waiting/i,
    ended: /you left the meeting|you've left the meeting|the meeting has ended|you've been removed|you have been removed|call ended|thanks for joining/i,
    captionsOn: () => {
      if (first('[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-text"]')) return 'on';
      const on = find([/^(turn on|show) live captions$/i, /^captions$/i]);
      if (on) return click(on) && 'clicked';
      const lang = find([/^language and speech$/i]);
      if (lang) return click(lang) && 'menu';
      const more = find([/^more$/i, /^more actions$/i, /^more options$/i]);
      return more ? click(more) && 'menu' : null;
    },
    captions() {
      return Array.from(document.querySelectorAll('[data-tid="closed-caption-text"]')).map((el) => {
        const item = el.closest('[data-tid="closed-caption-message"], .fui-ChatMessageCompact, li, [role="listitem"]') || el.parentElement;
        const author = item && item.querySelector('[data-tid="author"]');
        return { el, speaker: author ? norm(author.innerText) : 'Someone', text: norm(el.innerText) };
      });
    },
    chatMessages() {
      return Array.from(document.querySelectorAll('[data-tid="chat-pane-message"]')).map((el) => {
        const item = el.closest('[data-tid="chat-pane-item"], li, [role="listitem"]') || el.parentElement;
        const a = item && item.querySelector('[data-tid="message-author-name"]');
        return { el, speaker: a ? norm(a.innerText) : 'Someone', text: norm(el.innerText) };
      }).filter((m) => m.text);
    },
    leave: [/^leave$/i, /^leave \(ctrl/i, /^hang up$/i],
    leaveConfirm: [/^leave$/i, /^leave meeting$/i],
    chat: {
      open: [/^chat$/i, /^show conversation$/i, /^open chat$/i],
      input: () => first('[data-tid="ckeditor"], [contenteditable="true"][role="textbox"], textarea[placeholder*="message" i]'),
      send: [/^send$/i, /^send \(ctrl/i]
    }
  };

  const ALL = [meet, zoom, teams];
  window.ZoopePlatforms = {
    detect: (loc) => ALL.find((p) => p.match(loc)) || null,
    util: { find, click, setValue, typeInto, pressEnter, first, visible, label, bodyText, norm }
  };
})();
