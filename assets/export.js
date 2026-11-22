// cosight: what the page's Edit mode exports, kept out of index.html so a test can call it
// without a browser. index.html loads it as a plain script (window.CoSightExport);
// tests/export.test.ts imports it.
//
//   keyOf / refOf    an entry's key in the export list: "s:<n>" for a route stop (a stop Claude
//                    shows again keeps its place), "a:<id>" for an answer to a question
//   defaultOrder     the tour as the route list shows it: each stop, then the answers asked at it
//   arrange          the person's order and which sections they unticked, with everything that landed
//                    since slotted in where it belongs (a new answer under the stop it was asked at), ticked
//   ticked           the keys that go into the export: the order without the unticked ones
//   moveKey          one key moved in front of another
//   nested           whether an answer sits under its own stop, in the list and in the Markdown
//   runsOf           the highlighted lines as runs of code to quote, not the whole range on screen
//   markdownOf       the export: the writing, every diagram, and the quoted code
(function (root) {
  'use strict';

  var MERMAID_START = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Highlight runs closer than this many lines are quoted as one excerpt. */
  var JOIN_GAP = 3;

  function isMermaid(src) { return MERMAID_START.test(src || ''); }
  function keyOf(e) { return e.ask ? 'a:' + e.id : 's:' + e.n; }
  function refOf(k) { return k.charAt(0) === 'a' ? { type: 'aside', id: k.slice(2) } : { type: 'stop', n: Number(k.slice(2)) }; }

  /** Every entry of the document by its key. */
  function entriesOf(doc) {
    var m = {};
    (doc.stops || []).forEach(function (s) { m[keyOf(s)] = s; });
    (doc.asides || []).forEach(function (a) { m[keyOf(a)] = a; });
    return m;
  }

  /** The route stop number an entry belongs to: its own, or the one an answer was asked at (0 for none). */
  function groupOf(e) { return e.ask ? (e.from || 0) : e.n; }

  function defaultOrder(doc) {
    var out = [], have = {};
    var stops = (doc.stops || []).slice().sort(function (a, b) { return a.n - b.n; });
    stops.forEach(function (s) {
      have[s.n] = 1;
      out.push(keyOf(s));
      (doc.asides || []).forEach(function (a) { if ((a.from || 0) === s.n) out.push(keyOf(a)); });
    });
    // Answers asked before any stop landed come last, where the route list puts them.
    (doc.asides || []).forEach(function (a) { if (!have[a.from || 0]) out.push(keyOf(a)); });
    return out;
  }

  /** Index after the run of answers that follows order[at] and belongs to stop m. */
  function pastAnswers(order, at, m, ent) {
    var i = at + 1;
    while (i < order.length && order[i].charAt(0) === 'a' && ent[order[i]] && groupOf(ent[order[i]]) === m) i++;
    return i;
  }

  /** order[] index of the route stop with the highest number below `below` (or at most `below`). */
  function stopBefore(order, below, inclusive, ent) {
    var best = -1, bestN = -1;
    order.forEach(function (k, i) {
      var e = ent[k];
      if (!e || e.ask) return;
      if ((inclusive ? e.n <= below : e.n < below) && e.n > bestN) { best = i; bestN = e.n; }
    });
    return { at: best, n: bestN };
  }

  // A new answer goes under the stop it was asked at, after the answers already there; a new
  // stop goes after the stop before it and that stop's answers. Where that stop is not in the
  // list yet (never shown), the nearest one before it stands in.
  function slotIn(order, k, ent) {
    var e = ent[k];
    if (e.ask) {
      var f = e.from || 0;
      if (!f) { order.push(k); return; }
      var own = order.indexOf('s:' + f);
      if (own >= 0) { order.splice(pastAnswers(order, own, f, ent), 0, k); return; }
      for (var i = order.length - 1; i >= 0; i--) {
        var o = ent[order[i]];
        if (o && o.ask && (o.from || 0) === f) { order.splice(i + 1, 0, k); return; }
      }
      var near = stopBefore(order, f, true, ent);
      order.splice(near.at < 0 ? 0 : pastAnswers(order, near.at, near.n, ent), 0, k);
      return;
    }
    var prev = stopBefore(order, e.n, false, ent);
    order.splice(prev.at < 0 ? 0 : pastAnswers(order, prev.at, prev.n, ent), 0, k);
  }

  /**
   * The export list from what the person saved ({ order, off }, either may be missing): keys of
   * entries that are gone are dropped, and every entry not yet placed is slotted in, ticked.
   * Every section stays in the list, ticked or not, so unticking one never moves it and ticking
   * it again puts it back where it was. A list saved before the tick boxes ({ order, removed },
   * with the left-out sections missing from `order`) reads the same way: what was left out comes
   * back unticked, slotted in where it belongs.
   *
   * @returns order: every key, in the list's order; off: the unticked keys, in list order
   */
  function arrange(doc, saved) {
    var D = defaultOrder(doc), have = {}, isOff = {}, placed = {}, order = [];
    var ent = entriesOf(doc);
    D.forEach(function (k) { have[k] = 1; });
    var offs = saved ? (saved.off || saved.removed || []) : [];
    offs.forEach(function (k) { if (have[k]) isOff[k] = 1; });
    ((saved && saved.order) || D).forEach(function (k) {
      if (have[k] && !placed[k]) { placed[k] = 1; order.push(k); }
    });
    D.forEach(function (k) {
      if (placed[k]) return;
      slotIn(order, k, ent);
      placed[k] = 1;
    });
    return { order: order, off: order.filter(function (k) { return isOff[k]; }) };
  }

  /** The keys that go into the export: `ar.order` without the unticked ones. */
  function ticked(ar) {
    var no = {};
    (ar.off || []).forEach(function (k) { no[k] = 1; });
    return ar.order.filter(function (k) { return !no[k]; });
  }

  /** `order` with `key` moved in front of `before`; to the end when `before` is null or absent. */
  function moveKey(order, key, before) {
    if (key === before) return order.slice();
    var out = order.filter(function (k) { return k !== key; });
    var at = before == null ? -1 : out.indexOf(before);
    if (at < 0) out.push(key); else out.splice(at, 0, key);
    return out;
  }

  /** True when order[i] is an answer straight after its own stop, or after an answer to the same stop. */
  function nested(order, i, ent) {
    var e = ent[order[i]], p = i > 0 ? ent[order[i - 1]] : null;
    if (!e || !e.ask || !e.from || !p) return false;
    return groupOf(p) === e.from;
  }

  /**
   * The lines to quote for a stop: its highlighted lines as runs, runs closer than JOIN_GAP
   * joined, or the whole range when nothing is highlighted.
   */
  function runsOf(lines, start, end, gap) {
    var g = gap == null ? JOIN_GAP : gap;
    var ns = (lines || []).map(Number).filter(function (n) { return n > 0 && isFinite(n); }).sort(function (a, b) { return a - b; });
    if (!ns.length) return start > 0 && end >= start ? [{ from: start, to: end }] : [];
    var runs = [];
    ns.forEach(function (n) {
      var r = runs[runs.length - 1];
      if (r && n <= r.to + g + 1) r.to = Math.max(r.to, n);
      else runs.push({ from: n, to: n });
    });
    return runs;
  }

  /** A code fence longer than any run of backticks inside the text, so the text cannot close it. */
  function fence(text) {
    var longest = 0;
    (String(text).match(/`+/g) || []).forEach(function (m) { longest = Math.max(longest, m.length); });
    return new Array(Math.max(3, longest + 1) + 1).join('`');
  }

  /** Lines with their shared leading whitespace removed, so a quoted method starts at the margin. */
  function dedent(lines) {
    var cut = Infinity;
    lines.forEach(function (l) { if (l.trim()) cut = Math.min(cut, /^[ \t]*/.exec(l)[0].length); });
    if (!isFinite(cut) || !cut) return lines;
    return lines.map(function (l) { return l.slice(Math.min(cut, /^[ \t]*/.exec(l)[0].length)); });
  }

  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function linesText(a, b) { return a === b ? 'line ' + a : 'lines ' + a + '–' + b; }

  /** "Oct 14, 2026". */
  function dateText(d) { return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }

  /** "2026-10-14-how-does-a-run-flow.md": the date, then the title cut to a few words. */
  function fileNameOf(title, d) {
    var slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length > 60) slug = slug.slice(0, 60).replace(/-[^-]*$/, '');
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + (slug || 'cosight') + '.md';
  }

  /**
   * The Markdown for the entries named by `keys`, in that order.
   *
   * @param files  each file's whole text by its fileUrl; a missing one is noted in the export
   * @param opts   title (else the tour's question) and date, as dateText gives it
   * @returns the text, and how many sections, diagrams, excerpts and unloaded files went into it
   */
  function markdownOf(doc, keys, files, opts) {
    var ent = entriesOf(doc), o = opts || {}, out = [];
    var stats = { sections: 0, diagrams: 0, excerpts: 0, missing: 0 };
    var title = oneLine(o.title) || oneLine(doc.question) || 'CoSight';
    out.push('# ' + title, '');
    if (doc.question && oneLine(doc.question) !== title) out.push('> ' + oneLine(doc.question), '');
    var lens = doc.lens && doc.lens !== 'general' ? ', with a ' + doc.lens + ' focus' : '';
    out.push('*A code tour' + lens + (o.date ? ', ' + o.date : '') + '.*', '');

    keys.forEach(function (k, i) {
      var e = ent[k];
      if (!e) return;
      stats.sections++;
      var head = e.ask ? (e.title || e.ask) : (e.title || 'Stop ' + e.n);
      out.push((nested(keys, i, ent) ? '### ' : '## ') + oneLine(head), '');
      if (e.ask) out.push('> **Question:** ' + oneLine(e.ask), '');
      if (e.say && e.say.trim()) out.push(e.say.trim(), '');
      if (e.note && e.note.trim()) out.push(e.note.trim(), '');

      if (e.svg && e.svg.trim()) {
        var cap = [oneLine(e.diagramCaption), oneLine(e.diagramWhy)].filter(Boolean).join(': ');
        if (cap) out.push('*' + cap + '*', '');
        if (isMermaid(e.svg)) {
          var f = fence(e.svg);
          out.push(f + 'mermaid', e.svg.trim(), f, '');
        } else {
          // Raw SVG goes in as HTML; a blank line would end the HTML block halfway through it.
          out.push(e.svg.trim().replace(/\n\s*\n/g, '\n'), '');
        }
        stats.diagrams++;
      }

      if (e.file) {
        var text = files ? files[e.fileUrl] : undefined;
        var why = oneLine(e.codeWhy);
        if (text == null) {
          stats.missing++;
          out.push('`' + e.file + '`, ' + linesText(e.start, e.end) + ' (the file could not be loaded for this export)', '');
          return;
        }
        var all = String(text).replace(/\n$/, '').split('\n');
        runsOf(e.highlight, e.start, e.end).forEach(function (r) {
          var a = Math.max(1, r.from), b = Math.min(all.length, r.to);
          if (a > b) return;
          var body = dedent(all.slice(a - 1, b)).join('\n');
          var fc = fence(body);
          out.push('`' + e.file + '`, ' + linesText(a, b) + (why ? ': ' + why : ''), '');
          out.push(fc + (e.lang || ''), body, fc, '');
          why = '';
          stats.excerpts++;
        });
      }
    });

    var md = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    return { text: md, sections: stats.sections, diagrams: stats.diagrams, excerpts: stats.excerpts, missing: stats.missing };
  }

  var api = {
    isMermaid: isMermaid, keyOf: keyOf, refOf: refOf, entriesOf: entriesOf, defaultOrder: defaultOrder,
    arrange: arrange, ticked: ticked, moveKey: moveKey, nested: nested, runsOf: runsOf, fence: fence, dedent: dedent,
    dateText: dateText, fileNameOf: fileNameOf, markdownOf: markdownOf,
  };
  root.CoSightExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
