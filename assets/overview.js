// cosight: the project overview's pure logic, kept out of index.html so a test can call it
// without a browser. index.html loads it as a plain script (window.CoSightOverview);
// tests/overview.test.ts imports it.
//
//   keyOf      the name a rendered diagram is cached under on the tour server: FNV-1a over the
//              Mermaid source, a dash, its length (the same hash as fileKey in hooks/canvas.ts)
//   nodeOf     the overview box an entry lives in: its own, or for an answer the stop it was asked at
//   steps      the ordered moves the diagram pane makes between two entries
//   sentencesOf  the spoken text cut into sentences, the way a stop's `focus` counts them
//   cuesOf     when, in the voice, each sentence starts and which box of the stop's own diagram it is about
//   cueAt      the sentence the voice is on at a moment
//   motionOn   whether those moves animate, from the setting and the browser's reduced-motion flag
//   nodeMatch  how well one SVG element answers to a node id (data-id, Mermaid's own id, its label)
//   zoomFor    the zoom that puts a node's box, and its neighbourhood, in the middle of the pane
(function (root) {
  'use strict';

  /** The zoom a node gets: its box times this fills the pane. */
  var NEIGHBOURHOOD = 3;
  /** The zoom to a node stays between the fit scale times this and ZOOM_MAX. */
  var ABOVE_FIT = 1.3;
  var ZOOM_MAX = 3;

  /** FNV-1a 32-bit over the text's UTF-16 code units, hex padded to 8, then the text's length. */
  function keyOf(src) {
    var s = String(src == null ? '' : src), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex + '-' + s.length;
  }

  function stopByN(doc, n) {
    var stops = (doc && doc.stops) || [];
    for (var i = 0; i < stops.length; i++) if (stops[i].n === n) return stops[i];
    return null;
  }

  /**
   * The overview node an entry is shown at: its own `node`, else, for an answer, the node of
   * the stop it was asked at. null when neither names one.
   */
  function nodeOf(doc, e) {
    if (!e) return null;
    if (e.node) return String(e.node);
    if (e.ask && e.from) {
      var parent = stopByN(doc, e.from);
      if (parent && parent.node) return String(parent.node);
    }
    return null;
  }

  /**
   * The moves between the entry that was on screen (at `prev`, null for none) and the next
   * (at `next`, null for none), as plain steps the page plays in order. With motion on, each one
   * is its own slow, eased phase, so the eye can follow where the tour went:
   *   leave  fade the highlight off the box the tour is leaving
   *   out    zoom slowly back out to the whole overview
   *   pan    at the whole-overview scale, travel until the new box is in the middle
   *   in     zoom slowly in on the new box
   *   mark   highlight the new box
   *   hold   keep it there long enough to read, before the entry's own diagram takes over
   *   own    then the entry's own diagram
   * and, without motion or between equal boxes:
   *   fit    show the whole overview, at once
   *   jump   the new box, highlighted, at once (motion off)
   *   stay   the same box as before, highlighted: nothing moves
   *
   * @param opts motion: whether moves animate; own: the entry has a diagram of its own;
   *             first: nothing was on screen before (the tour's first show)
   */
  function steps(prev, next, opts) {
    var o = opts || {};
    var own = o.own ? [{ t: 'own' }] : [];
    var thenOwn = o.own ? [{ t: 'hold' }, { t: 'own' }] : [];
    if (!next) {
      if (o.motion && prev && !o.first) return [{ t: 'leave', node: prev }, { t: 'out' }].concat(own);
      return [{ t: 'fit' }].concat(own);
    }
    if (!o.motion) return [{ t: 'jump', node: next }].concat(thenOwn);
    var enter = [{ t: 'pan', node: next }, { t: 'in', node: next }, { t: 'mark', node: next }].concat(thenOwn);
    if (o.first) return [{ t: 'fit' }].concat(enter);
    if (prev === next) return [{ t: 'stay', node: next }].concat(thenOwn);
    if (!prev) return [{ t: 'out' }].concat(enter);
    return [{ t: 'leave', node: prev }, { t: 'out' }].concat(enter);
  }

  // A full stop after one of these is not the end of a sentence.
  var ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|cf|approx|Mr|Mrs|Ms|Dr|St|No)\.$/i;

  /**
   * The spoken text cut into sentences, each with where it starts in the text. A sentence ends at
   * . ! or ? (with any closing quotes or brackets after it) followed by white space, or at a blank
   * line; a full stop inside a word (`file.ts`, `1.5`) or after e.g., i.e., vs. and the like does
   * not end one. This is how a stop's `focus` is counted: one entry per sentence, in order.
   */
  function sentencesOf(text) {
    var s = String(text == null ? '' : text), out = [], from = 0;
    var re = /[.!?]+["')\]\u201d\u2019]*(?=\s)|\n\s*\n/g, m;
    function push(to) {
      var piece = s.slice(from, to), lead = piece.length - piece.replace(/^\s+/, '').length;
      var body = piece.trim();
      if (body) out.push({ text: body, start: from + lead });
    }
    while ((m = re.exec(s))) {
      var end = m.index + m[0].length;
      if (m[0].charAt(0) === '.' && m[0].length === 1 && ABBREV.test(s.slice(Math.max(0, m.index - 8), end))) continue;
      push(end);
      from = end;
    }
    push(s.length);
    return out;
  }

  /**
   * When each sentence starts in the voice, and the box of the stop's own diagram it is about.
   * The voice gives no word timings, so a sentence's start is estimated as its share of the
   * characters before it times the whole length of the speech (in seconds; 0 when not known yet).
   * `focus` has one entry per sentence; a missing entry is "" (no box).
   */
  function cuesOf(say, focus, duration) {
    var ss = sentencesOf(say), total = 0, f = focus || [];
    ss.forEach(function (x) { total += x.text.length; });
    var d = duration > 0 && isFinite(duration) ? duration : 0, before = 0;
    return ss.map(function (x, i) {
      var c = { at: total ? (before / total) * d : 0, char: x.start, node: typeof f[i] === 'string' ? f[i].trim() : '' };
      before += x.text.length;
      return c;
    });
  }

  /**
   * The index of the cue the voice is on: by `t` seconds into the speech, or, when `char` is given
   * (the browser voice's boundary events say which character it reached), by character. -1 before
   * the first.
   */
  function cueAt(cues, t, char) {
    var at = -1, useChar = char != null && char >= 0;
    for (var i = 0; i < cues.length; i++) {
      if (useChar ? cues[i].char <= char : cues[i].at <= t) at = i; else break;
    }
    return at;
  }

  /** 'on' and 'off' are what they say; anything else follows the browser's reduced-motion flag. */
  function motionOn(setting, reducedMotion) {
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    return !reducedMotion;
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

  /**
   * How well an SVG element answers to a node id, best first: 3 for its data-id (what some
   * Mermaid versions put on nodes), 2 for Mermaid's element id (`flowchart-<id>-12`,
   * `classId-<id>-3`, `state-<id>-7`, each with or without the render id in front, as 12.1
   * writes `mmd3-flowchart-<id>-12`; a cluster is `<render id>-<id>`), 1 for a label equal to
   * the id ignoring case, 0 for none.
   */
  function nodeMatch(cand, id) {
    if (!id || !cand) return 0;
    var want = String(id), w = escapeRe(want);
    if (cand.dataId != null && String(cand.dataId) === want) return 3;
    if (cand.id) {
      var el = String(cand.id);
      if (new RegExp('^(?:.+-)?(?:flowchart|classId|state)-' + w + '-\\d+$').test(el)) return 2;
      if (new RegExp('^(?:[^-\\s]+-)?' + w + '$').test(el)) return 2;
    }
    if (cand.label != null && norm(cand.label) && norm(cand.label) === norm(want)) return 1;
    return 0;
  }

  /**
   * The zoom that centres a node's box (in the diagram's own, untransformed pixels) in a pane of
   * `pane.w` by `pane.h`: the box times NEIGHBOURHOOD fills the pane, between the fit scale times
   * ABOVE_FIT and ZOOM_MAX, so a stop on a small box shows what is around it, never a wall of one box.
   */
  function zoomFor(box, pane, fitK) {
    var want = Math.min(pane.w / (box.w * NEIGHBOURHOOD), pane.h / (box.h * NEIGHBOURHOOD));
    if (!isFinite(want) || want <= 0) want = ZOOM_MAX;
    var lo = Math.max(0.05, (fitK > 0 ? fitK : 1) * ABOVE_FIT);
    var k = Math.min(ZOOM_MAX, Math.max(lo, want));
    return { k: k, x: pane.w / 2 - (box.x + box.w / 2) * k, y: pane.h / 2 - (box.y + box.h / 2) * k };
  }

  var api = {
    keyOf: keyOf, nodeOf: nodeOf, steps: steps, sentencesOf: sentencesOf, cuesOf: cuesOf, cueAt: cueAt, motionOn: motionOn, nodeMatch: nodeMatch, zoomFor: zoomFor,
  };
  root.CoSightOverview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
