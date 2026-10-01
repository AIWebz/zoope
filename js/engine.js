/*
 * zoope brain — runs entirely in the browser, no external APIs.
 *
 * For every line said in a meeting it decides whether the user's avatar
 * should speak (turn-taking score) and, if so, what to say (intent
 * detection + retrieval over the user's own knowledge notes).
 */
(function (global) {
  'use strict';

  var STOP = ('a an the and or but if so to of in on at for with from by is are was were be been being am ' +
    'i me my we our you your he she it they them their this that these those do does did have has had ' +
    'will would can could should shall may might must just about into over than then there here what ' +
    'which who whom how when where why not no yes ok okay um uh like also very really get got let lets ' +
    'going go gonna want any some all its it\'s i\'m im you\'re we\'re there\'s that\'s let\'s let\' ' +
    'everyone everybody anyone thanks thank great sure yep yeah hey hi hello bye right now today okay hear').split(' ');
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = true; });

  var QUESTION_START = /^(what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|should|have|has|any|anything|shall|may)\b/i;
  var GROUP_ASK = /\b(anyone|anybody|everyone|everybody|all of you|you all|y'all|folks|team|thoughts|any updates|go around|round the room|around the room|any questions|any objections)\b/i;
  var GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|welcome|morning)\b/i;
  var FAREWELL = /\b(bye|goodbye|see you|talk soon|that's all|thats all|wrap (it )?up|end the (call|meeting)|have a good (one|day|weekend))\b/i;
  var THANKS = /\b(thanks|thank you|cheers|appreciate it)\b/i;
  var HEAR_CHECK = /\b(can (you|everyone|everybody|you all|y'all|people) hear (me|us)|are you (there|with us)|you on mute|are you muted)\b/i;
  // a sincere question about whether this is a person or an AI (always answered truthfully)
  var AI_CHECK = /\b(are you (a |an )?(bot|ai|robot|machine|real person|human|recording|avatar|deepfake)|are you real|is (this|that) (really|actually|even) (you|him|her|them)|am i (talking|speaking) (to|with) (a |an )?(bot|ai|robot|machine|person|human|real)|is this (a |an )?(bot|ai|recording|deepfake)|you sound like (a |an )?(robot|bot|ai)|is (this|that) an? (ai|bot))/i;
  var INTRO = /\b(introduce yourself|who('s| is) (this|that|on the call|joining)|who are you|what should we call you|what do (we|people) call you|what's your name|what is your name)\b/i;
  var UPDATE = /\b(update|status|progress|how('s| is) (it|that|the \w+) going|where are (we|you) (at|with)|what are you working on|what have you been|what's new|anything new)\b/i;
  var AVAIL = /\b(available|free|can you make|does .* work for you|what time works|schedule|calendar|when can you)\b/i;
  var OPINION = /\b(what do you think|thoughts|your (take|opinion|view)|do you agree|agree\?|how do you feel|sound good|sounds good\?|make sense\?)\b/i;
  var REQUEST = /\b(can|could|would|will) you (please )?(send|share|take|handle|own|look|check|write|draft|review|follow|prepare|set up|update|fix|finish|send over|circle back|ping|email|book|schedule|create|put together)\b/i;
  var DEADLINE = /\b(by|before|until|due|on)\s+(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of (the )?(day|week|month)|eod|eow|next week|next \w+|\w+ \d{1,2}(st|nd|rd|th)?)\b/i;
  var TRAILING = /(\b(and|but|so|because|or|um|uh|like|the|a|an|to|of|with|for|that|if|when|is|are|was|we|i)|,|…|\.\.\.)\s*$/i;
  var THIRD_PERSON_AFTER = /^('s|\s+(is|was|has|had|will|said|did|does|and|or|mentioned|thinks|told))\b/i;

  function norm(s) { return String(s || '').toLowerCase().replace(/[’`]/g, "'"); }

  function stem(w) {
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function tokens(s) {
    return (norm(s).match(/[a-z0-9']+/g) || [])
      .filter(function (w) { return !STOPSET[w] && w.length > 1; })
      .map(stem);
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length, prev = [], cur, i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function splitSentences(text) {
    return String(text || '')
      .split(/(?<=[.!?])\s+|\n+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 2; });
  }

  function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }

  function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---------- Knowledge retrieval (TF-IDF over the user's notes) ---------- */

  function KnowledgeBase(text) {
    this.sentences = splitSentences(text);
    this.docs = this.sentences.map(tokens);
    var df = {};
    this.docs.forEach(function (d) {
      var seen = {};
      d.forEach(function (t) { if (!seen[t]) { seen[t] = true; df[t] = (df[t] || 0) + 1; } });
    });
    var N = this.docs.length || 1;
    this.idf = {};
    for (var t in df) this.idf[t] = Math.log(1 + N / df[t]);
  }

  KnowledgeBase.prototype.search = function (query, k) {
    var q = tokens(query), self = this;
    if (!q.length || !this.docs.length) return [];
    var qset = {};
    q.forEach(function (t) { qset[t] = true; });
    var qnorm = Math.sqrt(Object.keys(qset).reduce(function (s, t) {
      var w = self.idf[t] || Math.log(1 + self.docs.length); return s + w * w;
    }, 0));
    return this.docs.map(function (d, i) {
      var dset = {}, dot = 0, dn = 0;
      d.forEach(function (t) { dset[t] = true; });
      for (var t in dset) {
        var w = self.idf[t] || 0;
        dn += w * w;
        if (qset[t]) dot += w * w;
      }
      return { text: self.sentences[i], score: dn && qnorm ? dot / (Math.sqrt(dn) * qnorm) : 0 };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, k || 2);
  };

  /* ---------------------------- Engine ---------------------------- */

  function ZoopeEngine(profile, opts) {
    opts = opts || {};
    this.profile = profile || {};
    this.names = (profile.names || []).concat(profile.fullName ? [profile.fullName] : [])
      .map(function (n) { return norm(n).trim(); })
      .filter(Boolean);
    // first name from full name also counts
    if (profile.fullName) this.names.push(norm(profile.fullName).split(/\s+/)[0]);
    this.names = this.names.filter(function (n, i, a) { return a.indexOf(n) === i; });
    this.preferred = profile.preferred || (profile.names && profile.names[0]) || (profile.fullName || 'me').split(' ')[0];
    // notes the user sent to zoope: background facts, and things to bring up in the meeting
    var notes = (profile.notes || []).filter(function (n) { return n && n.text; });
    var noteText = notes.map(function (n) { return n.text.replace(/[.!?]?\s*$/, '.'); }).join(' ');
    this.kb = new KnowledgeBase(((profile.knowledge || '') + ' ' + noteText).trim());
    this.pendingShares = notes.filter(function (n) { return n.kind === 'share'; }).map(function (n) { return { id: n.id, text: n.text }; });
    this.sharedNotes = [];
    this.attendees = (opts.attendees || []).map(function (a) { return a.trim(); }).filter(Boolean);
    this.speakers = [];
    this.summoned = null;
    this.threshold = opts.threshold || 0.5;
    this.history = [];
    this.turn = 0;
    this.lastAITurn = -99;
    this.actionItems = [];
    this.followUps = [];
    this.unknownNames = [];
    this.answered = 0;
    this.decisions = [];
  }

  ZoopeEngine.prototype.isMyName = function (word) {
    word = norm(word);
    for (var i = 0; i < this.names.length; i++) {
      var n = this.names[i];
      if (word === n) return true;
      // tolerate speech-to-text misspellings on longer names
      if (n.length >= 5 && Math.abs(n.length - word.length) <= 1 && levenshtein(n, word) <= 1) return true;
    }
    return false;
  };

  // Finds how my names appear in a line: 'vocative' (talking to me), 'mention' (about me) or null.
  ZoopeEngine.prototype.findMyName = function (text) {
    var t = norm(text), best = null;
    for (var i = 0; i < this.names.length; i++) {
      var re = new RegExp('(^|[^a-z])(' + escapeRe(this.names[i]) + ')(?![a-z])', 'g'), m;
      while ((m = re.exec(t))) {
        var after = t.slice(m.index + m[0].length);
        if (THIRD_PERSON_AFTER.test(after)) { best = best || 'mention'; } else { return 'vocative'; }
      }
    }
    if (best) return best;
    // fuzzy match on single words (speech recognition errors)
    var words = t.match(/[a-z']+/g) || [];
    for (var j = 0; j < words.length; j++) {
      if (words[j].length >= 4 && this.isMyName(words[j])) return 'vocative';
    }
    return null;
  };

  // Is the line directed at a *different* attendee? e.g. "Sam, can you…" / "…, Sam?"
  ZoopeEngine.prototype.addressedToOther = function (text, speaker) {
    var t = norm(text).trim(), self = this;
    for (var i = 0; i < this.attendees.length; i++) {
      var a = norm(this.attendees[i]).split(/\s+/)[0];
      if (!a || a === norm(speaker).split(/\s+/)[0] || self.isMyName(a)) continue;
      var start = new RegExp('(^|[.!?]\\s+)(hey |hi |ok |okay |so |and )?' + escapeRe(a) + '\\s*[,:]');
      var end = new RegExp('[,]\\s*' + escapeRe(a) + '\\s*[?.!]*$');
      var over = new RegExp('\\b(over to|what about|how about|thanks|thank you),?\\s+' + escapeRe(a) + '\\b');
      if (start.test(t) || end.test(t) || over.test(t)) return this.attendees[i];
    }
    return null;
  };

  // A capitalised vocative that is neither an attendee nor one of my names might be a nickname.
  ZoopeEngine.prototype.unknownVocative = function (text) {
    var m = String(text).match(/^(?:[Hh]ey |[Hh]i |[Oo]k |[Ss]o )?([A-Z][a-zA-Z]{1,14})[,:]\s/) ||
            String(text).match(/,\s*([A-Z][a-zA-Z]{1,14})\s*[?.!]*$/);
    if (!m) return null;
    var w = m[1], lw = norm(w), self = this;
    var common = ['so', 'ok', 'okay', 'well', 'right', 'yes', 'no', 'thanks', 'great', 'sure', 'guys', 'everyone', 'team', 'all', 'folks', 'also', 'and', 'but', 'now', 'alright',
      'yeah', 'yep', 'honestly', 'actually', 'look', 'listen', 'first', 'second', 'next', 'finally', 'anyway', 'hmm',
      'perfect', 'cool', 'awesome', 'nice', 'good', 'sorry', 'hello', 'hi', 'hey', 'morning', 'basically', 'however',
      'then', 'again', 'otherwise', 'plus', 'oh', 'wow', 'true', 'exactly', 'absolutely', 'definitely', 'agreed',
      'correct', 'understood', 'noted', 'today', 'tomorrow', 'yesterday', 'bye', 'please', 'guys', 'people'];
    if (common.indexOf(lw) >= 0 || this.isMyName(lw)) return null;
    if (this.attendees.some(function (a) { return norm(a).split(/\s+/)[0] === lw; })) return null;
    if (self.unknownNames.indexOf(w) >= 0) return null;
    return w;
  };

  ZoopeEngine.prototype.isQuestion = function (text) {
    var t = String(text).trim();
    return /\?\s*$/.test(t) || QUESTION_START.test(t.replace(/^[A-Za-z]+,\s*/, ''));
  };

  /* Decide whether to speak. Returns {speak, score, reasons, intent, reply} */
  ZoopeEngine.prototype.hear = function (speaker, text) {
    this.turn++;
    var entry = { turn: this.turn, speaker: speaker, text: text, ai: false };
    this.history.push(entry);

    var reasons = [], score = 0, self0 = this;
    var t = String(text || '').trim();
    var question = this.isQuestion(t);
    var nameUse = this.findMyName(t);
    var other = this.addressedToOther(t, speaker);
    var turnsSinceMe = this.turn - this.lastAITurn;
    var hits = this.kb.search(t, 2);
    var relevance = hits.length ? hits[0].score : 0;
    var intent = this.intentOf(t);

    if (nameUse === 'vocative') {
      score += question || intent !== 'statement' ? 0.9 : 0.6;
      reasons.push('Called by name (+' + (question || intent !== 'statement' ? '0.9' : '0.6') + ')');
    } else if (nameUse === 'mention') {
      score += 0.15;
      reasons.push('Talked about, not to (+0.15)');
    }

    // just my name ("Alex?", "Hey Alex") means they want my attention: answer "Yes?"
    var rest = norm(t).replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(function (w) {
      return w && !/^(hey|so|um|uh|ok|okay|and|oh|yo|excuse|me|sorry|quick|question)$/.test(w) && !self0.isMyName(w);
    });
    var summon = nameUse === 'vocative' && rest.length === 0;
    if (summon) { score += 0.9; reasons.push('Just my name: they want my attention (+0.9)'); intent = 'summon'; }
    // after "Alex?" … "Yes?", their next line is for me
    var afterSummon = !nameUse && this.summoned && this.summoned.speaker === speaker && this.turn - this.summoned.turn <= 2;
    if (afterSummon) { score += 0.9; reasons.push('Continuing after calling me (+0.9)'); }
    this.summoned = summon ? { speaker: speaker, turn: this.turn } : (afterSummon ? null : this.summoned);

    // one-on-one: with only one other person, every finished line is for me
    if (speaker && this.speakers.indexOf(speaker) < 0) this.speakers.push(speaker);
    var oneOnOne = this.attendees.length <= 1 && this.speakers.length === 1;
    if (oneOnOne && !summon && !afterSummon && !other) { score += 0.8; reasons.push('One-on-one: I answer every turn (+0.8)'); }

    if (other && nameUse !== 'vocative') {
      score -= 0.9;
      reasons.push('Directed at ' + other + ' — not my turn (−0.9)');
    }

    if (!nameUse && !other && GROUP_ASK.test(t) && question) {
      var g = 0.3 + Math.min(0.4, relevance);
      score += g;
      reasons.push('Question to the whole group (+' + g.toFixed(2) + ')');
    }

    var followUp = !nameUse && !other && turnsSinceMe <= 2 && question && (/\byou(r)?\b/i.test(t) || relevance >= 0.2);
    if (followUp) {
      score += 0.55;
      reasons.push('Follow-up to what I just said (+0.55)');
    }

    if (!nameUse && !other && !followUp && question && relevance >= 0.3 && !GROUP_ASK.test(t)) {
      var r = Math.min(0.35, relevance * 0.5);
      score += r;
      reasons.push('Question about something I know (+' + r.toFixed(2) + ')');
    }

    if (intent === 'aicheck' && !other) {
      score += 0.9;
      reasons.push('Asked whether this is an AI: always answered truthfully (+0.9)');
    }

    if ((intent === 'hearcheck' || intent === 'intro') && !other) {
      score += 0.4;
      reasons.push('Check-in / introduction request (+0.4)');
    }

    if (intent === 'farewell' && !other && this.turn > 2) {
      score += 0.55;
      reasons.push('Meeting is wrapping up (+0.55)');
    }

    if (turnsSinceMe === 1 && nameUse !== 'vocative' && !followUp && intent !== 'farewell' && !oneOnOne && !afterSummon) {
      score -= 0.2;
      reasons.push('I just spoke — avoid dominating (−0.2)');
    }

    if (TRAILING.test(t) && !question) {
      score -= 0.5;
      reasons.push('Speaker has not finished — don\'t interrupt (−0.5)');
    }

    // Record action items addressed to me even if we then reply.
    if (REQUEST.test(t) && (nameUse === 'vocative' || (!other && turnsSinceMe <= 2))) {
      var dl = t.match(DEADLINE);
      this.actionItems.push({ from: speaker, text: t, due: dl ? dl[0] : null });
      reasons.push('Logged as an action item');
    }

    var unknown = this.unknownVocative(t);
    if (unknown) {
      this.unknownNames.push(unknown);
      reasons.push('Someone was called “' + unknown + '” — I\'ll ask if that\'s you');
    }

    score = Math.max(-1, Math.min(1.5, score));
    var speak = score >= this.threshold;
    this.addressedByName = nameUse === 'vocative' || afterSummon;
    this.oneOnOne = oneOnOne;
    var reply = speak ? this.respond(speaker, t, intent, hits) : null;
    if (reply && this.history.some(function (h) { return h.ai && h.text === reply; }) && reply.length > 40) {
      reply = 'Like I said, ' + reply.charAt(0).toLowerCase() + reply.slice(1);
    }
    if (!speak) reasons.push('Staying quiet (' + score.toFixed(2) + ' < ' + this.threshold + ')');

    var decision = { speaker: speaker, text: t, score: score, speak: speak, reasons: reasons, intent: intent, reply: reply };
    this.decisions.push(decision);
    if (speak) this.said(reply);
    return decision;
  };

  ZoopeEngine.prototype.said = function (text) {
    this.turn++;
    this.lastAITurn = this.turn;
    this.history.push({ turn: this.turn, speaker: this.preferred, text: text, ai: true });
  };

  ZoopeEngine.prototype.intentOf = function (t) {
    if (AI_CHECK.test(t)) return 'aicheck';
    if (HEAR_CHECK.test(t)) return 'hearcheck';
    if (INTRO.test(t)) return 'intro';
    if (FAREWELL.test(t)) return 'farewell';
    if (REQUEST.test(t)) return 'request';
    if (AVAIL.test(t)) return 'availability';
    if (UPDATE.test(t)) return 'update';
    if (OPINION.test(t)) return 'opinion';
    if (GREETING.test(t) && t.split(/\s+/).length <= 6) return 'greeting';
    if (THANKS.test(t) && !this.isQuestion(t)) return 'thanks';
    if (this.isQuestion(t)) return 'question';
    return 'statement';
  };

  // Only answer from a note that clearly matches the question; a loose match could be wrong.
  ZoopeEngine.prototype.fromKnowledge = function (hits, min) {
    var good = hits.filter(function (h) { return h.score >= (min || 0.3); });
    if (!good.length) return null;
    var out = good[0].text;
    if (good[1] && good[1].score >= 0.3 && good[1].score > good[0].score * 0.85) out += ' ' + good[1].text;
    return out;
  };

  /* The AI engine wrote a better reply for this turn: record that one instead. */
  ZoopeEngine.prototype.replaceLastReply = function (text, answered) {
    for (var i = this.history.length - 1; i >= 0; i--) if (this.history[i].ai) { this.history[i].text = text; break; }
    var d = this.decisions[this.decisions.length - 1];
    if (d) d.reply = text;
    // it answered after all: that question no longer waits on the user
    if (answered && this.followUps.length && this.followUps[this.followUps.length - 1].turn === this.turn) this.followUps.pop();
  };

  ZoopeEngine.prototype.followUp = function (speaker, t) {
    this.followUps.push({ from: speaker, text: t, turn: this.turn });
    return 'follow up on that';
  };

  /*
   * How zoope speaks: in the first person, as the user, from the user's notes.
   *  - facts come only from the user's notes (and only clearly matching ones);
   *  - it never agrees, commits or gives an opinion beyond those notes;
   *  - when it doesn't know, it says it will follow up after the call;
   *  - asked sincerely whether it is an AI, it says so. It never denies it.
   */
  ZoopeEngine.prototype.respond = function (speaker, t, intent, hits) {
    var who = String(speaker || '').split(/\s+/)[0];
    var seed = this.turn + t.length;
    var self = this;
    var known = this.fromKnowledge(hits);
    // a follow-up about the note zoope just read out may match it only loosely
    if (!known && hits[0] && hits[0].score >= 0.15 && this.lastNote && this.lastNote.indexOf(hits[0].text) >= 0 && this.turn - this.lastNoteTurn <= 3) {
      known = hits[0].text;
    }
    var me = this.preferred;
    var say = function (k) { self.lastNote = k; self.lastNoteTurn = self.turn; return k; };
    var reply;

    switch (intent) {
      case 'summon':
        reply = 'Yes?';
        break;
      case 'aicheck':
        reply = 'Fair question. This is my AI avatar, speaking for me from my notes. I\'m not on the call live, and I\'ll get a summary afterwards.';
        break;
      case 'hearcheck':
        reply = pick(['Yes, I can hear you.', 'Yes, ' + who + ', loud and clear.'], seed);
        break;
      case 'intro':
        var others = this.names.filter(function (n) { return norm(n) !== norm(me) && n.indexOf(' ') < 0; }).map(capitalise);
        reply = 'Hi, I\'m ' + (this.profile.fullName || me) + '. ' + (others.length ? me + ' is fine, or ' + others.slice(0, 2).join(' or ') + '.' : 'Call me ' + me + '.');
        break;
      case 'greeting':
        reply = pick(['Hi ' + who + '.', 'Hey ' + who + '.', 'Hi everyone.'], seed);
        break;
      case 'farewell':
        reply = 'Thanks everyone, talk soon.';
        if (this.pendingShares.length) reply = 'Before we wrap up, one thing from me: ' + this.takeShares() + ' ' + reply;
        break;
      case 'thanks':
        reply = 'Sure thing.';
        break;
      case 'request':
        var dl = t.match(DEADLINE);
        reply = 'Noted' + (dl ? ', ' + dl[0] : '') + '. I\'ll confirm after the call.';
        break;
      case 'availability':
        if (known) { reply = say(known); break; }
        this.followUp(speaker, t);
        reply = 'Let me check my calendar and get back to you after the call.';
        break;
      case 'update':
        var parts = [];
        if (known) parts.push(say(known));
        if (this.pendingShares.length) parts.push(this.takeShares());
        if (parts.length) { reply = parts.join(' '); break; }
        this.followUp(speaker, t);
        reply = 'I don\'t have an update on that in front of me. I\'ll send one after the call.';
        break;
      case 'opinion':
        if (known) { reply = say(known); break; }
        this.followUp(speaker, t);
        reply = 'I\'d like to look at that properly before giving an opinion. I\'ll follow up after the call.';
        break;
      case 'question':
        if (known) { this.answered++; reply = say(known); break; }
        this.followUp(speaker, t);
        reply = 'I don\'t have that in front of me, ' + who + '. I\'ll get back to you after the call.';
        break;
      default:
        if (known) { reply = say(known); break; }
        // a statement: acknowledge it in a way that fits what was said, and keep the conversation going
        if (/\b(sorry|unfortunately|problem|issue|bug|blocked|delay(ed)?|late|behind|broke|broken|stuck)\b/i.test(t)) {
          reply = pick(['Ah, okay. What do you need from me to get it unblocked?', 'Thanks for flagging it. Is there anything I can do to help?', 'Okay, good to know. What\'s the plan to fix it?'], seed);
        } else if (/\b(done|finished|shipped|launched|fixed|approved|merged|on track|great news|signed)\b/i.test(t)) {
          reply = pick(['Nice, that\'s great to hear.', 'Great, thanks ' + who + '.', 'Love it. What\'s next on that?'], seed);
        } else if (/\b(i think|i feel|in my opinion|maybe we|we should|what if)\b/i.test(t)) {
          reply = pick(['That makes sense. Let me think it over and I\'ll get back to you with my take.', 'Interesting idea. I\'ll look at it properly after the call.'], seed);
          this.followUp(speaker, t);
        } else if (this.oneOnOne || this.addressedByName) {
          reply = pick(['Got it.', 'Okay, makes sense.', 'Right, thanks ' + who + '.', 'Okay. Anything else on that?', 'Mm-hm, got it.'], seed);
        } else {
          reply = 'Got it, thanks ' + who + '.';
        }
    }
    // the first time zoope is addressed, it also brings up anything the user asked it to share
    if (this.pendingShares.length && this.addressedByName && ['aicheck', 'farewell', 'update', 'hearcheck', 'greeting'].indexOf(intent) < 0 && !this.sharedOnce) {
      this.sharedOnce = true;
      reply += ' Also, quick note from me: ' + this.takeShares();
    }
    return reply;
  };

  // Turns a note into something said in the meeting: "Tell Priya the budget is approved" -> "Priya, the budget is approved."
  function noteToSpeech(text) {
    var t = String(text).trim().replace(/\s+/g, ' ');
    var m = t.match(/^(?:please\s+)?(?:tell|let)\s+([A-Z][\w'-]*|everyone|everybody|the team|them|people)\s+(?:know\s+)?(?:that\s+)?(.+)$/i);
    if (m) {
      var who = /^(everyone|everybody|the team|them|people)$/i.test(m[1]) ? '' : capitalise(m[1]) + ', ';
      t = who + m[2];
    } else {
      t = t.replace(/^(?:please\s+)?(?:say|mention|share|bring up|let everyone know|let the team know)\s+(?:that\s+)?/i, '');
    }
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?]$/.test(t) ? t : t + '.';
  }

  ZoopeEngine.prototype.takeShares = function () {
    var out = this.pendingShares.map(function (n) { return noteToSpeech(n.text); }).join(' ');
    this.sharedNotes = this.sharedNotes.concat(this.pendingShares);
    this.pendingShares = [];
    return out;
  };

  // A note the user sends during the meeting, to be said at the next pause.
  ZoopeEngine.prototype.relay = function (text) {
    var line = noteToSpeech(text);
    this.kb = new KnowledgeBase(this.kb.sentences.concat([text]).join(' '));
    this.said(line);
    return line;
  };

  ZoopeEngine.prototype.greetOnJoin = function () {
    var line = 'Hi everyone, ' + this.preferred + ' here.';
    // the join greeting shouldn't count against turn-taking
    this.history.push({ turn: this.turn, speaker: this.preferred, text: line, ai: true });
    return line;
  };

  ZoopeEngine.prototype.summary = function () {
    var counts = {}, freq = {}, skip = {};
    this.names.concat(this.attendees).forEach(function (n) { norm(n).split(/\s+/).forEach(function (w) { skip[stem(w)] = true; }); });
    this.history.forEach(function (h) {
      counts[h.speaker] = (counts[h.speaker] || 0) + 1;
      if (!h.ai) tokens(h.text).forEach(function (w) { if (w.length > 3 && !skip[w]) freq[w] = (freq[w] || 0) + 1; });
    });
    var topics = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 6);
    return {
      turns: this.history.length,
      speakers: counts,
      spoke: this.decisions.filter(function (d) { return d.speak; }).length,
      stayedQuiet: this.decisions.filter(function (d) { return !d.speak; }).length,
      topics: topics,
      actionItems: this.actionItems,
      followUps: this.followUps,
      unknownNames: this.unknownNames
    };
  };

  global.ZoopeEngine = ZoopeEngine;
  global.ZoopeNoteToSpeech = noteToSpeech;
  global.ZoopeKnowledgeBase = KnowledgeBase;
})(window);
