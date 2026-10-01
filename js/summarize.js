/*
 * Meeting summaries, on-device.
 *
 * Builds a written summary from a meeting transcript: an overview paragraph,
 * the key points (the most central lines, ranked TextRank-style), decisions,
 * action items with owner and due date, follow-ups for the user, and what
 * zoope said on the user's behalf. Everything is extracted from what was
 * actually said; nothing is invented.
 */
(function (global) {
  'use strict';

  var STOP = ('a an the and or but if so to of in on at for with from by is are was were be been being am i me my we our you your ' +
    'he she it they them their this that these those do does did have has had will would can could should shall may might must just ' +
    'about into over than then there here what which who whom how when where why not no yes ok okay um uh like also very really get got ' +
    'let lets going go gonna want any some all its it\'s i\'m im you\'re we\'re there\'s that\'s let\'s everyone everybody thanks thank ' +
    'great sure yep yeah hey hi hello bye right now today one two think know need make sounds good well start quick').split(' ');
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = true; });

  var ACK = /^(yes|yeah|yep|sure|ok(ay)?|got it|sounds good|will do|thanks?( you)?|great|perfect|cool|right|hi|hello|hey|bye|goodbye)\b[\s\S]{0,25}$/i;
  var DECISION = /\b(let's|we'll|we will|we're going to|we are going to|decided|agreed|agree to|go with|going with|approved|signed off|sign off|moving forward|final answer|ship it|plan is)\b/i;
  var DEADLINE = /\b(by|before|until|due|on)\s+(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of (the )?(day|week|month)|eod|eow|next week|next \w+|\w+ \d{1,2}(st|nd|rd|th)?)\b/i;
  var ASK = /^(?:(?:hey|so|and|ok|okay)\s+)?([A-Z][\w'-]+),?\s+(?:can|could|would|will)\s+you\s+(?:please\s+)?(.+?)\??$/;
  var SELF = /\b(?:i'll|i will|i can|i'm going to|i am going to)\s+(.+?)(?:[.!?]|$)/i;

  function tokens(s) {
    return (String(s).toLowerCase().match(/[a-z0-9']+/g) || []).filter(function (w) { return w.length > 2 && !STOPSET[w]; })
      .map(function (w) { return w.replace(/(ing|ed|es|s)$/, ''); });
  }
  function sentences(text) {
    return String(text).split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function cosine(a, b) {
    var dot = 0, na = 0, nb = 0, k;
    for (k in a) { na += a[k] * a[k]; if (b[k]) dot += a[k] * b[k]; }
    for (k in b) nb += b[k] * b[k];
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function clean(task) {
    return String(task).replace(/\s*\b(by|before|until)\s+.*$/i, '').replace(/^(please\s+)/i, '').replace(/[?.!\s]+$/, '');
  }
  function listJoin(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function fmtDuration(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  /*
   * history: [{ speaker, text, ai }]; meta: { title, platform, started, ended, user, attendees,
   * followUps, sharedNotes }. Returns a structured summary with a markdown rendering.
   */
  function summarize(history, meta) {
    meta = meta || {};
    var user = meta.user || 'You';
    var people = history.filter(function (h) { return !h.ai; });

    // ---- candidate sentences (skip greetings, acks and cut-off fragments)
    var cands = [];
    people.forEach(function (h, li) {
      sentences(h.text).forEach(function (s) {
        if (s.split(/\s+/).length < 4 || ACK.test(s) || /,\s*$|\band$/.test(s)) return;
        cands.push({ speaker: h.speaker, text: s, line: li });
      });
    });

    // ---- rank by centrality (sum of similarity to every other sentence), plus content bonuses
    var df = {};
    var vecs = cands.map(function (c) {
      var tf = {};
      tokens(c.text).forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      return tf;
    });
    var N = cands.length || 1;
    vecs.forEach(function (v) { for (var t in v) v[t] *= Math.log(1 + N / df[t]); });
    cands.forEach(function (c, i) {
      var s = 0;
      for (var j = 0; j < cands.length; j++) if (j !== i) s += cosine(vecs[i], vecs[j]);
      if (DECISION.test(c.text)) s += 0.6;
      if (/\d/.test(c.text)) s += 0.3;
      if (DEADLINE.test(c.text)) s += 0.3;
      if (/\?$/.test(c.text)) s -= 0.25;
      c.score = s + Math.min(0.3, tokens(c.text).length * 0.03);
    });
    // key points are statements; questions and requests are covered by follow-ups and action items
    var statements = cands.filter(function (c) { return !/\?$/.test(c.text) && !ASK.test(c.text); });
    var keyPoints = statements.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, Math.min(6, Math.max(3, Math.ceil(statements.length * 0.6))))
      .sort(function (a, b) { return a.line - b.line; });

    // ---- decisions
    var decisions = cands.filter(function (c) { return DECISION.test(c.text) && !/\?$/.test(c.text); })
      .map(function (c) { return { speaker: c.speaker, text: c.text }; });

    // ---- action items for everyone, with owners
    var items = [];
    people.forEach(function (h, i) {
      var t = h.text.trim(), m = t.match(ASK);
      if (m) {
        var owner = m[1], next = people[i + 1];
        var accepted = next && next.speaker && next.speaker.split(/\s+/)[0].toLowerCase() === owner.toLowerCase() && /\b(sure|will do|yes|ok|okay|on it|no problem|can do)\b/i.test(next.text);
        var due = t.match(DEADLINE);
        items.push({ owner: owner, task: cap(clean(m[2])), due: due ? due[0] : null, from: h.speaker, accepted: !!accepted });
        return;
      }
      var self = t.match(SELF);
      if (self && !/\?$/.test(t)) {
        var d2 = t.match(DEADLINE);
        items.push({ owner: h.speaker, task: cap(clean(self[1])), due: d2 ? d2[0] : null, from: h.speaker, accepted: true });
      }
    });
    // requests made to the user (owner may be a nickname): normalise to the user's name
    var names = (meta.userNames || []).map(function (n) { return n.toLowerCase(); });
    items.forEach(function (it) { if (names.indexOf(String(it.owner).toLowerCase()) >= 0) it.owner = user; });
    var mine = items.filter(function (it) { return it.owner === user; });

    // ---- follow-ups: questions zoope couldn't answer from the notes
    var followUps = (meta.followUps || []).map(function (f) { return { from: f.from, text: f.text }; });

    // ---- what zoope said for the user
    var said = history.filter(function (h) { return h.ai; }).map(function (h) { return h.text; });

    // ---- topics: frequent content words, excluding names
    var skip = {};
    (meta.attendees || []).concat(meta.userNames || [], [user]).forEach(function (n) { tokens(n).forEach(function (t) { skip[t] = true; }); });
    var freq = {};
    people.forEach(function (h) { tokens(h.text).forEach(function (t) { if (!skip[t] && t.length > 3) freq[t] = (freq[t] || 0) + 1; }); });
    var topics = Object.keys(freq).filter(function (t) { return freq[t] > 1; }).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 4);
    if (!topics.length) topics = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 3);

    // ---- overview paragraph
    var counts = {};
    people.forEach(function (h) { counts[h.speaker] = (counts[h.speaker] || 0) + 1; });
    var speakers = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    var started = meta.started ? new Date(meta.started) : null, ended = meta.ended ? new Date(meta.ended) : null;
    var overview = [];
    overview.push((meta.title || 'The meeting') + (meta.platform ? ' (' + meta.platform + ')' : '') +
      (started ? ' on ' + started.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '') +
      (started && ended ? ' ran ' + fmtDuration(ended - started) : '') + '.');
    if (speakers.length) overview.push(listJoin(speakers) + ' spoke' + (speakers.length > 1 ? ', with ' + speakers[0] + ' leading the discussion' : '') + '.');
    if (topics.length) overview.push('It covered ' + listJoin(topics) + '.');
    var tally = [];
    if (decisions.length) tally.push(decisions.length + ' decision' + (decisions.length > 1 ? 's' : ''));
    if (items.length) tally.push(items.length + ' action item' + (items.length > 1 ? 's' : '') + (mine.length ? ' (' + mine.length + ' for you)' : ''));
    if (followUps.length) tally.push(followUps.length + ' question' + (followUps.length > 1 ? 's' : '') + ' waiting on you');
    if (tally.length) overview.push('Outcome: ' + listJoin(tally) + '.');
    if (said.length) overview.push('Your avatar spoke ' + said.length + ' time' + (said.length > 1 ? 's' : '') + ' for you.');

    var out = {
      title: meta.title || 'Meeting', platform: meta.platform || '', started: meta.started || null, ended: meta.ended || null,
      attendees: speakers, overview: overview.join(' '),
      keyPoints: keyPoints.map(function (k) { return { speaker: k.speaker, text: k.text }; }),
      decisions: decisions, actionItems: items, mine: mine, followUps: followUps, said: said,
      sharedNotes: (meta.sharedNotes || []).map(function (n) { return n.text; }), topics: topics
    };
    out.markdown = toMarkdown(out);
    return out;
  }

  function toMarkdown(s) {
    var L = [];
    L.push('# ' + s.title);
    if (s.started) L.push('_' + new Date(s.started).toLocaleString() + (s.platform ? ' · ' + s.platform : '') + '_');
    L.push('', s.overview, '');
    var sec = function (title, arr, fmt) { if (!arr.length) return; L.push('## ' + title); arr.forEach(function (x) { L.push('- ' + fmt(x)); }); L.push(''); };
    sec('Key points', s.keyPoints, function (k) { return '**' + k.speaker + ':** ' + k.text; });
    sec('Decisions', s.decisions, function (d) { return d.text + ' (' + d.speaker + ')'; });
    sec('Action items', s.actionItems, function (a) { return '**' + a.owner + '**: ' + a.task + (a.due ? ', ' + a.due : '') + (a.owner !== a.from ? ' (asked by ' + a.from + ')' : ''); });
    sec('Waiting on you', s.followUps, function (f) { return f.from + ' asked: “' + f.text + '”'; });
    sec('Shared from your notes', s.sharedNotes, function (n) { return n; });
    sec('What your avatar said', s.said, function (t) { return t; });
    return L.join('\n');
  }

  global.ZoopeSummarize = { summarize: summarize, toMarkdown: toMarkdown };
})(window);
