/* Nordic Balancing Watch: plain JS, no build step, no dependencies. */
(function () {
  "use strict";

  var CFG = window.NBW_CONFIG || {};
  var STALE_MS = 45 * 60 * 1000;  /* data is published every 15 minutes */
  var REFRESH_MS = 15 * 60 * 1000;

  /* Sources are grouped into three categories so colour stays meaningful:
     eSett, ENTSO-E and the national TSOs (each TSO covers its own zones). */
  var CAT = { esett: "esett", entsoe: "entsoe", energidataservice: "tso", fingrid: "tso", svk: "tso" };
  var CAT_ORDER = ["esett", "entsoe", "tso"];
  var CAT_LABEL = { esett: "eSett", entsoe: "ENTSO-E", tso: "National TSO", completed: "Completed by a later auction" };
  var CAT_SHAPE = { esett: "circle", entsoe: "square", tso: "diamond" };
  var SRC_LABEL = {
    esett: "eSett", entsoe: "ENTSO-E", energidataservice: "Energinet",
    fingrid: "Fingrid", svk: "Svenska kraftnät"
  };
  var KIND_LABEL = { changed: "Changed", withdrawn: "Withdrawn", completed: "Completed by a later auction" };
  var COUNTRY = { DK: "Denmark", FI: "Finland", NO: "Norway", SE: "Sweden" };
  var ZONES = ["DK1", "DK2", "FI", "NO1", "NO2", "NO3", "NO4", "NO5", "SE1", "SE2", "SE3", "SE4"];

  /* The glossary is written in the page itself, so it reads without JavaScript; the tooltips
     on glossary terms take their definitions from it. */
  var GLOSSARY = {};
  document.querySelectorAll("#glossary > div[id^='g-']").forEach(function (d) {
    var text = function (sel) { return d.querySelector(sel).textContent.replace(/\s+/g, " ").trim(); };
    GLOSSARY[d.id.slice(2)] = [text("dt"), text("dd")];
  });

  var state = { tz: load("nbw.tz", "UTC"), zones: load("nbw.zones", null), summary: null, revisions: [], tables: {}, kept: null, cov: { label: "last 7 days" } };
  /* A stored value from an older version, or an edited one, must not break every time on the page. */
  if (["UTC", "Europe/Stockholm"].indexOf(state.tz) < 0) state.tz = "UTC";
  function inZones(z) { return !state.zones || state.zones.indexOf(z) >= 0; }
  function term(key, text) { return '<span class="term" data-term="' + key + '">' + text + "</span>"; }
  /* An entry a later auction completed is not a revision: the first price was a
     provisional total. It is shown, but never counted as a revision. Energinet's FCR
     markets are joint across several zones, so one auction can appear once per zone;
     wherever a count is shown it counts once. */
  function isCompletion(r) { return r.kind === "completed"; }
  function dedupeJoint(revs) {
    var seen = {};
    return revs.filter(function (r) {
      if (!isCompletion(r)) return true;
      var k = [r.source, r.data, r.interval_start, r.revised_at, r.old, r.new].join("|");
      return seen[k] ? false : (seen[k] = true);
    });
  }
  /* Every price change seen on a series in the window: revisions plus completions. */
  function rePriced(g) { return (g.last7.revisions || 0) + (g.last7.completions || 0); }
  /* A completion is one event in a joint market, so it is never summed across zones:
     the zone's products are summed first, then said per zone — equal zones, a min–max
     range, or a single zone's count. */
  function perZoneCompletions(gs) {
    var byZone = {};
    gs.forEach(function (g) { byZone[g.zone] = (byZone[g.zone] || 0) + (g.last7.completions || 0); });
    var done = Object.keys(byZone).map(function (z) { return ru().of(byZone[z]); });
    if (!sum(done)) return null;
    var lo = Math.min.apply(null, done), hi = Math.max.apply(null, done), u = ru().many;
    return done.length === 1 ? "in <b>" + fmtInt(lo) + " " + u + "</b>"
      : lo === hi ? "in <b>" + fmtInt(lo) + " " + u + " in each zone</b>"
      : "in <b>" + fmtInt(lo) + "–" + fmtInt(hi) + " " + u + " per zone</b>";
  }
  /* Every reserve capacity source publishes one price per hour; the library spreads each
     hourly price over four quarter-hour records that are first seen, completed and revised
     together. Reserve counts are therefore shown per hour, the unit the source published.
     If any count is not a multiple of four, a source has changed its resolution, and the
     page falls back to quarter-hours rather than guess. */
  var RU_HOUR = { div: 4, one: "hour", many: "hours", zone: "zone-hours", delivery: "delivery hours", deliveryOne: "delivery hour" };
  var RU_QUARTER = { div: 1, one: "quarter-hour", many: "quarter-hours", zone: "zone-quarter-hours", delivery: "delivery quarter-hours", deliveryOne: "delivery quarter-hour" };
  function reserveUnit(s) {
    var counts = [];
    reserveGroups(s || {}).forEach(function (g) {
      ["n", "revisions", "completions", "seen_after_start", "late"].forEach(function (k) {
        if (g.last7 && typeof g.last7[k] === "number") counts.push(g.last7[k]);
      });
    });
    var c7 = (s && s.completions_7d) || {};
    [c7.zone_intervals, c7.market_intervals].forEach(function (x) { if (typeof x === "number") counts.push(x); });
    var unit = counts.every(function (n) { return n % 4 === 0; }) ? RU_HOUR : RU_QUARTER;
    unit.of = function (n) { return n == null ? n : n / unit.div; };
    return unit;
  }
  function ru() { return state.ru || (state.ru = reserveUnit(state.summary)); }
  /* Real revisions may be summed across zones, under a label that says so. */
  function zoneSum(gs) { return sum(gs.map(function (g) { return g.last7.revisions || 0; })); }
  function lagOf(gs, k) { return median(gs.map(function (g) { return g.last7[k]; }).filter(function (v) { return v != null; })); }

  /* ---------- small helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function sum(a) { return a.reduce(function (s, x) { return s + x; }, 0); }
  function median(a) {
    if (!a.length) return null;
    var v = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  /* "a, b and c" */
  function joinList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  function cat(source) { return CAT[source] || "tso"; }
  function catColor(c) { return "var(--s-" + c + ")"; }
  function country(zone) { return COUNTRY[zone.slice(0, 2)] || zone; }
  function zoneIndex(z) { var i = ZONES.indexOf(z); return i < 0 ? 99 : i; }

  function fmtInt(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-GB"); }
  /* A share that is not zero never reads as zero: 7 of 17,751 is "<0.1%", not "0.0%". */
  function fmtPct(x, digits) {
    if (x == null || !isFinite(x)) return "—";
    var d = digits == null ? (x > 0 && x < 0.1 ? 1 : 0) : digits;
    var s = (x * 100).toFixed(d);
    return x > 0 && Number(s) === 0 ? "<" + Math.pow(10, -d).toFixed(d) + "%" : s + "%";
  }
  /* "2 in 5", "1 in 6": the nearest simple fraction, for plain-language sentences. A share
     under a tenth is "1 in N" with N rounded to two significant digits ("1 in 5,900"). */
  function simpleFraction(x) {
    if (x > 0 && x < 0.1) return "1 in " + fmtInt(Number((1 / x).toPrecision(2)));
    var c = [[1, 2], [2, 5], [1, 3], [1, 4], [1, 5], [1, 6], [1, 8], [1, 10]];
    var best = c.reduce(function (b, f) { return Math.abs(f[0] / f[1] - x) < Math.abs(b[0] / b[1] - x) ? f : b; });
    return best[0] === 1 && best[1] === 2 ? "half" : best[0] + " in " + best[1];
  }
  function fmtMin(m) { return m == null ? "—" : Math.round(m) + " min"; }
  function fmtDur(min) {
    if (min == null) return "—";
    var a = Math.abs(min);
    if (a < 90) return Math.round(a) + " min";
    if (a < 48 * 60) return (a / 60).toFixed(a < 600 ? 1 : 0) + " h";
    return (a / 1440).toFixed(1) + " days";
  }
  function fmtHours(h) { return h == null ? "—" : h.toFixed(h < 10 ? 1 : 0) + " h"; }
  /* Prices go into HTML unescaped, so anything that is not a finite number is shown as a dash. */
  function fmtPrice(p) {
    if (typeof p !== "number" || !isFinite(p)) return "—";
    var d = Math.abs(p) < 10 && p !== Math.round(p) ? 3 : 2;
    return p.toLocaleString("en-GB", { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d });
  }

  /* Times follow the zone picked in the top bar (UTC or Nordic time). */
  function fmtTime(iso, opts) {
    var o = { timeZone: state.tz };
    for (var k in opts) o[k] = opts[k];
    return new Intl.DateTimeFormat("en-GB", o).format(new Date(iso));
  }
  function tzName(iso) {
    if (state.tz === "UTC") return "UTC";
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, timeZoneName: "short" })
      .formatToParts(new Date(iso));
    var p = parts.filter(function (x) { return x.type === "timeZoneName"; })[0];
    return p ? p.value.replace("GMT+1", "CET").replace("GMT+2", "CEST") : "";
  }
  function dateTime(iso) {
    return fmtTime(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  /* A timestamp that matches the contract's pattern can still be an impossible date. */
  function validTime(iso) { return iso && !isNaN(Date.parse(iso)) ? iso : null; }
  function longDate(iso) { return fmtTime(iso, { day: "numeric", month: "short", year: "numeric" }); }
  function relTime(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  /* "DK2, SE1–SE4": zones grouped by country, consecutive numbers collapsed. */
  function zoneRange(zones) {
    var by = {};
    uniq(zones).sort(function (a, b) { return zoneIndex(a) - zoneIndex(b); }).forEach(function (z) {
      var c = z.slice(0, 2);
      (by[c] = by[c] || []).push(z);
    });
    return Object.keys(by).map(function (c) {
      var list = by[c], out = [], i = 0;
      while (i < list.length) {
        var j = i, n = function (z) { return parseInt(z.slice(2), 10); };
        while (j + 1 < list.length && !isNaN(n(list[j + 1])) && n(list[j + 1]) === n(list[j]) + 1) j++;
        out.push(j - i >= 2 ? list[i] + "–" + list[j] : list.slice(i, j + 1).join(", "));
        i = j + 1;
      }
      return out.join(", ");
    }).join(", ");
  }

  function marker(shape, cx, cy, r, fill, ring) {
    var stroke = ring ? ' stroke="var(--surface)" stroke-width="2"' : "";
    if (shape === "square") {
      var s = r * 0.9;
      return '<rect x="' + (cx - s) + '" y="' + (cy - s) + '" width="' + 2 * s + '" height="' + 2 * s +
        '" rx="1.5" fill="' + fill + '"' + stroke + "/>";
    }
    if (shape === "diamond") {
      var d = r * 1.2;
      return '<path d="M' + cx + " " + (cy - d) + "L" + (cx + d) + " " + cy + "L" + cx + " " + (cy + d) +
        "L" + (cx - d) + " " + cy + 'Z" fill="' + fill + '"' + stroke + "/>";
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"' + stroke + "/>";
  }
  /* Price change, finance style: green up, red down, with the relative change when the
     base is large enough for a percentage to mean something (opts.minBase, 1 unless stated). */
  function chg(from, to, opts) {
    if (from == null || to == null) return "";
    var d = to - from, dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    var p = Math.abs(from) >= (opts && opts.minBase || 1) ? d / Math.abs(from) : null;
    var arrow = { up: "▲", down: "▼", flat: "" }[dir];
    var text = dir === "flat" ? "0.00" : (d > 0 ? "+" : "−") + fmtPrice(Math.abs(d));
    return '<span class="chg ' + dir + (opts && opts.plain ? " plain" : "") + '">' + arrow + (arrow ? " " : "") + text +
      (p != null && dir !== "flat" ? '<span class="pc">' + (p > 0 ? "+" : "−") + Math.abs(p * 100).toFixed(Math.abs(p) < 0.1 ? 1 : 0) + "%</span>" : "") +
      "</span>";
  }
  function sparkline(values) {
    var v = (values || []).filter(function (x) { return x != null; });
    if (v.length < 2) return "";
    var w = 96, h = 26, pad = 3;
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), span = hi - lo || 1;
    var pts = v.map(function (x, i) {
      return [pad + i * (w - 2 * pad) / (v.length - 1), pad + (hi - x) * (h - 2 * pad) / span];
    });
    var last = v[v.length - 1], dir = last > v[0] ? "up" : last < v[0] ? "down" : "flat";
    var color = { up: "var(--up)", down: "var(--down)", flat: "var(--muted)" }[dir];
    var line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var end = pts[pts.length - 1];
    var zero = lo < 0 && hi > 0 ? '<line x1="' + pad + '" x2="' + (w - pad) + '" y1="' + (pad + hi * (h - 2 * pad) / span).toFixed(1) +
      '" y2="' + (pad + hi * (h - 2 * pad) / span).toFixed(1) + '" stroke="var(--axis)" stroke-dasharray="2 2"/>' : "";
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true">' + zero +
      '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + end[0].toFixed(1) + '" cy="' + end[1].toFixed(1) + '" r="2.4" fill="' + color + '"/></svg>';
  }
  function swatch(c) {
    return '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
      marker(CAT_SHAPE[c], 6, 6, 4.5, catColor(c), false) + "</svg>";
  }
  function srcCell(source) {
    return '<span class="src">' + swatch(cat(source)) + esc(SRC_LABEL[source] || source) + "</span>";
  }
  function legend(el, cats, extra) {
    el.innerHTML = cats.map(function (c) {
      return "<span>" + swatch(c) + esc(CAT_LABEL[c]) + "</span>";
    }).join("") + (extra || "");
  }

  /* ---------- tooltip ---------- */

  var tip = null;
  function showTip(html, x, y) {
    /* An open modal dialog sits above the page, so it carries its own tooltip. */
    var zd = $("zd");
    if (tip) tip.classList.remove("on");
    tip = zd && zd.open ? $("zd-tip") : $("tooltip");
    tip.innerHTML = html;
    tip.classList.add("on");
    var w = tip.offsetWidth, h = tip.offsetHeight, pad = 12;
    var left = x + pad + w > window.innerWidth - 8 ? x - w - pad : x + pad;
    var top = y + pad + h > window.innerHeight - 8 ? y - h - pad : y + pad;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { if (tip) tip.classList.remove("on"); }
  function tipRow(c, label, value) {
    return '<div class="t-row">' + swatch(c) + "<span>" + esc(label) + "</span><b>" + value + "</b></div>";
  }
  /* Hover, focus and touch on elements with data-tip index into a list of HTML strings. */
  function bindTips(root, tips) {
    root.querySelectorAll("[data-tip]").forEach(function (node) {
      var html = tips[+node.getAttribute("data-tip")];
      node.addEventListener("pointermove", function (e) { showTip(html, e.clientX, e.clientY); });
      node.addEventListener("pointerleave", hideTip);
      node.addEventListener("focus", function () {
        var r = node.getBoundingClientRect();
        node.classList.add("active");
        showTip(html, r.left + r.width / 2, r.top + r.height);
      });
      node.addEventListener("blur", function () { node.classList.remove("active"); hideTip(); });
    });
  }

  /* Glossary terms: hover, keyboard focus or tap shows the definition. */
  function bindTerms(root) {
    root.querySelectorAll(".term:not([data-bound])").forEach(function (node) {
      var g = GLOSSARY[node.getAttribute("data-term")];
      if (!g) return;
      node.setAttribute("data-bound", "1");
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", node.textContent + ": " + g[1]);
      var html = '<div class="t-title">' + esc(g[0]) + '</div><div>' + esc(g[1]) + "</div>";
      var at = function () { var r = node.getBoundingClientRect(); showTip(html, r.left, r.bottom); };
      node.addEventListener("pointerenter", function (e) { if (e.pointerType !== "touch") showTip(html, e.clientX, e.clientY); });
      node.addEventListener("pointerleave", function (e) { if (e.pointerType !== "touch") hideTip(); });
      node.addEventListener("focus", at);
      node.addEventListener("blur", hideTip);
      node.addEventListener("click", function (e) { e.stopPropagation(); at(); });
    });
  }

  /* ---------- charts (inline SVG) ---------- */

  function niceStep(max, target) {
    var raw = max / target, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / pow;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow;
  }

  /* Dot-range rows: per zone, one marker per source at the median and a line to P95. */
  function dotRange(el, rows, opt) {
    var W = Math.max(280, el.clientWidth), L = 56, R = 14, ROW = 26, HEAD = 24, AX = 34;
    var plotW = W - L - R;
    var maxV = Math.max.apply(null, rows.map(function (r) {
      return Math.max.apply(null, r.items.map(function (i) { return i.p95 == null ? i.p50 : i.p95; }));
    }).concat([30]));
    var step = opt.step || (W < 480 ? 30 : 15);
    var xmax = Math.ceil(maxV / step) * step;
    var x = function (v) { return L + Math.min(v, xmax) / xmax * plotW; };
    var y = 4, body = "", tips = [], lastGroup = null;
    rows.forEach(function (r) {
      if (r.group !== lastGroup) {
        y += lastGroup == null ? 0 : 6;
        body += '<text class="group-label" x="0" y="' + (y + 15) + '">' + esc(r.group) + "</text>";
        y += HEAD;
        lastGroup = r.group;
      }
      var cy = y + ROW / 2;
      tips.push(r.tip);
      body += '<rect class="row-hit" x="0" y="' + y + '" width="' + W + '" height="' + ROW +
        '" rx="4" tabindex="0" data-tip="' + (tips.length - 1) + '" aria-label="' + esc(r.aria) + '"/>';
      body += '<text class="row-label" x="8" y="' + (cy + 4) + '" pointer-events="none">' + esc(r.label) + "</text>";
      var placed = [];
      r.items.forEach(function (it) {
        var c = catColor(it.cat), x1 = x(it.p50), x2 = x(it.p95 == null ? it.p50 : it.p95);
        /* Markers that would sit on top of each other are moved apart vertically. */
        var clash = placed.filter(function (px) { return Math.abs(px - x1) < 9; }).length;
        placed.push(x1);
        var cy = y + ROW / 2 + (clash ? (clash % 2 ? -5 : 5) : 0);
        body += '<g pointer-events="none">';
        if (x2 - x1 > 1) {
          body += '<line x1="' + x1 + '" x2="' + x2 + '" y1="' + cy + '" y2="' + cy + '" stroke="' + c +
            '" stroke-width="2" stroke-linecap="round" opacity="0.55"/>' +
            '<line x1="' + x2 + '" x2="' + x2 + '" y1="' + (cy - 4) + '" y2="' + (cy + 4) + '" stroke="' + c +
            '" stroke-width="2" stroke-linecap="round" opacity="0.7"/>';
        }
        body += marker(CAT_SHAPE[it.cat], x1, cy, 5.5, c, true) + "</g>";
      });
      y += ROW;
    });
    var grid = "", ticks = "";
    for (var t = 0; t <= xmax; t += step) {
      grid += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="0" y2="' + y + '"/>';
      ticks += '<text x="' + x(t) + '" y="' + (y + 16) + '" text-anchor="middle">' + t + "</text>";
    }
    var H = y + AX;
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '">' +
      '<g class="grid">' + grid + "</g>" + body +
      '<line class="axis-line" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/>' +
      '<g class="tick">' + ticks + "</g>" +
      '<text class="axis-title" x="' + (W - R) + '" y="' + (y + 31) + '" text-anchor="end">' + esc(opt.axis) + "</text></svg>";
    bindTips(el, tips);
  }

  /* Horizontal bars with a label column and the value printed past the bar end. */
  function hbars(el, rows, opt) {
    if (!rows.length) { el.innerHTML = '<p class="empty-chart">' + esc(opt.empty) + "</p>"; return; }
    var W = Math.max(280, el.clientWidth), AX = 26, BAR = 12;
    var L = Math.min(170, Math.round(W * 0.38)), VAL = Math.min(130, Math.round(W * 0.3));
    /* When the longest label does not fit beside the bars, every label goes above its bar. */
    var g2 = (hbars.canvas = hbars.canvas || document.createElement("canvas")).getContext("2d");
    g2.font = "12.5px " + getComputedStyle(el).fontFamily;
    var widest = Math.max.apply(null, rows.map(function (r) { return g2.measureText(r.label).width; }));
    var stacked = widest + 14 > L, ROW = stacked ? 42 : 30;
    g2.font = "12px " + getComputedStyle(el).fontFamily;  /* the value labels */
    if (stacked) L = 6;
    var plotW = W - L - VAL;
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    var step = opt.step ? opt.step(maxV) : niceStep(maxV, 4);
    var xmax = Math.max(step, Math.ceil(maxV / step) * step);
    var x = function (v) { return L + v / xmax * plotW; };
    var body = "", tips = [], y = 2;
    rows.forEach(function (r) {
      var cy = stacked ? y + 29 : y + ROW / 2, x0 = L, x1 = Math.max(L + 2, x(r.value)), top = cy - BAR / 2, rad = 4;
      tips.push(r.tip);
      body += '<rect class="row-hit" x="0" y="' + y + '" width="' + W + '" height="' + ROW +
        '" rx="4" tabindex="0" data-tip="' + (tips.length - 1) + '" aria-label="' + esc(r.aria) + '"/>';
      body += '<g pointer-events="none"><text class="row-label' + (stacked ? " over" : "") + '" x="6" y="' + (stacked ? y + 15 : cy + 4) + '">' + esc(r.label) + "</text>";
      var rr = Math.min(rad, (x1 - x0) / 2);
      body += '<path d="M' + x0 + " " + top + "H" + (x1 - rr) + "Q" + x1 + " " + top + " " + x1 + " " + (top + rr) +
        "V" + (top + BAR - rr) + "Q" + x1 + " " + (top + BAR) + " " + (x1 - rr) + " " + (top + BAR) + "H" + x0 +
        'Z" fill="' + r.color + '"/>';
      /* A value label that would run past the chart gives way to its short form (the tooltip keeps the full one). */
      var vtext = r.short && x1 + 8 + g2.measureText(r.text).width > W - 4 ? r.short : r.text;
      body += '<text class="val-label" x="' + (x1 + 8) + '" y="' + (cy + 4) + '">' + esc(vtext) + "</text></g>";
      y += ROW;
    });
    var grid = "", ticks = "";
    for (var t = 0; t <= xmax + 1e-9; t += step) {
      grid += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="0" y2="' + y + '"/>';
      ticks += '<text x="' + x(t) + '" y="' + (y + 16) + '" text-anchor="middle">' + esc(opt.tick(t)) + "</text>";
    }
    var H = y + AX;
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '">' +
      '<g class="grid">' + grid + "</g>" + body +
      '<line class="axis-line" x1="' + L + '" x2="' + L + '" y1="0" y2="' + y + '"/>' +
      '<g class="tick">' + ticks + "</g></svg>";
    bindTips(el, tips);
  }

  /* Columns per time bucket (stacked when given several categories, 2px surface gap). */
  function stackedColumns(el, buckets, cats, opt) {
    var W = Math.max(200, el.clientWidth), L = 36, R = 4, T = 8, B = opt.axis === false ? 4 : 22, GAP = 2;
    var H = (opt.height || 150) + B;
    var totals = buckets.map(function (b) { return sum(cats.map(function (c) { return b.counts[c] || 0; })); });
    /* Counts are whole numbers: the y axis steps by at least 1 and ends on a round value. */
    var step = Math.max(1, niceStep(Math.max.apply(null, totals.concat([1])), opt.height >= 100 ? 4 : 2));
    var ymax = Math.ceil(Math.max.apply(null, totals.concat([1])) / step) * step;
    var plotH = H - T - B, colW = (W - L - R) / buckets.length;
    var grid = "", ticks = "", body = "", tips = [];
    for (var v = step; v <= ymax; v += step) {
      var gy = T + plotH - v / ymax * plotH;
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/>';
      ticks += '<text x="' + (L - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + fmtInt(v) + "</text>";
    }
    ticks += '<text x="' + (L - 6) + '" y="' + (T + plotH + 4) + '" text-anchor="end">0</text>';
    var barW = Math.max(1, colW - (colW > 4 ? 1.5 : 0.5));
    /* Hour labels between the day labels, as often as the width allows (every 3, 6 or 12 hours). */
    var hourStep = opt.hourTicks ? [3, 6, 12].filter(function (h) { return h * colW >= 44; })[0] : null;
    buckets.forEach(function (b, i) {
      var x0 = L + i * colW, base = T + plotH;
      if (b.dayLabel) {
        if (opt.axis !== false) ticks += '<text x="' + (x0 + 3) + '" y="' + (H - 6) + '">' + esc(b.dayLabel) + "</text>";
        grid += '<line x1="' + x0 + '" x2="' + x0 + '" y1="' + T + '" y2="' + (T + plotH) + '"/>';
      } else if (hourStep && b.hourLabel && b.hour % hourStep === 0 && opt.axis !== false) {
        ticks += '<text class="hour" x="' + (x0 + 3) + '" y="' + (H - 6) + '">' + esc(b.hourLabel) + "</text>";
      }
      cats.forEach(function (c) {
        var n = b.counts[c] || 0;
        if (!n) return;
        var h = n / ymax * plotH, top = base - h;
        body += '<rect x="' + x0 + '" y="' + top + '" width="' + barW + '" height="' + Math.max(1, h - GAP) +
          '" rx="' + Math.min(2, barW / 2) + '" fill="' + catColor(c) + '"/>';
        base = top;
      });
      tips.push('<div class="t-title">' + esc(b.title) + "</div>" + cats.map(function (c) {
        return tipRow(c, CAT_LABEL[c], fmtInt(b.counts[c] || 0));
      }).join(""));
      body += '<rect class="row-hit" x="' + x0 + '" y="' + T + '" width="' + colW + '" height="' + plotH +
        '" data-tip="' + i + '"/>';
    });
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '"><g class="grid">' + grid + "</g>" +
      '<line class="axis-line" x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + plotH) + '" y2="' + (T + plotH) + '"/>' +
      '<g class="tick">' + ticks + "</g>" + body + "</svg>";
    bindTips(el, tips);
  }

  /* Lines per category over days, with a per-day hover column. */
  function lines(el, days, series, opt) {
    var W = Math.max(280, el.clientWidth), H = 240, L = 44, R = 16, T = 10, B = 30;
    var all = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
    var step = niceStep(Math.max.apply(null, all.concat([30])), 4);
    var ymax = Math.ceil(Math.max.apply(null, all.concat([30])) / step) * step;
    var x = function (i) { return L + (days.length === 1 ? 0.5 : i / (days.length - 1)) * (W - L - R); };
    var y = function (v) { return T + (1 - v / ymax) * (H - T - B); };
    var grid = "", ticks = "", body = "", tips = [];
    for (var t = 0; t <= ymax; t += step) {
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>';
      ticks += '<text x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + t + "</text>";
    }
    var every = Math.ceil(days.length / Math.max(2, Math.floor((W - L) / 70)));
    days.forEach(function (d, i) {
      if (i % every === 0) ticks += '<text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(d.slice(5)) + "</text>";
    });
    series.forEach(function (s) {
      var pts = s.values.map(function (v, i) { return v == null ? null : [x(i), y(v)]; });
      var path = "", pen = false;
      pts.forEach(function (p) { if (!p) { pen = false; return; } path += (pen ? "L" : "M") + p[0] + " " + p[1]; pen = true; });
      body += '<path d="' + path + '" fill="none" stroke="' + catColor(s.cat) + '" stroke-width="2" stroke-linejoin="round"/>';
      pts.forEach(function (p) { if (p) body += marker(CAT_SHAPE[s.cat], p[0], p[1], 4, catColor(s.cat), true); });
    });
    var colW = days.length > 1 ? (W - L - R) / (days.length - 1) : W - L - R;
    days.forEach(function (d, i) {
      tips.push('<div class="t-title">' + esc(d) + "</div>" + series.map(function (s) {
        return tipRow(s.cat, CAT_LABEL[s.cat], s.values[i] == null ? "—" : fmtMin(s.values[i]));
      }).join(""));
      body += '<rect class="row-hit" x="' + (x(i) - colW / 2) + '" y="' + T + '" width="' + colW + '" height="' +
        (H - T - B) + '" tabindex="0" data-tip="' + i + '" aria-label="' + esc(d) + '"/>';
    });
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '"><g class="grid">' + grid + "</g>" +
      '<line class="axis-line" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>' +
      '<g class="tick">' + ticks + "</g>" + body +
      '<text class="axis-title" x="' + L + '" y="' + (T - 2) + '">' + esc(opt.axis) + "</text></svg>";
    bindTips(el, tips);
  }

  /* ---------- data table: search, filters, sort, reorder, hide, CSV ---------- */

  var SEARCH_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function DataTable(mount, cfg) {
    var self = this;
    this.cfg = cfg;
    this.rows = cfg.rows;
    var defOrder = cfg.columns.map(function (c) { return c.key; });
    var defHidden = cfg.columns.filter(function (c) { return c.hidden; }).map(function (c) { return c.key; });
    var saved = load("nbw.table." + cfg.id, {});
    var valid = function (list) { return Array.isArray(list) && list.every(function (k) { return defOrder.indexOf(k) >= 0; }); };
    this.order = valid(saved.order) && saved.order.length === defOrder.length ? saved.order : defOrder.slice();
    this.hidden = valid(saved.hidden) ? saved.hidden : defHidden.slice();
    this.sort = saved.sort && defOrder.indexOf(saved.sort.key) >= 0 ? saved.sort : cfg.sort;
    this.filters = {};
    this.q = "";
    this.limit = cfg.page || 50;
    this.col = {};
    cfg.columns.forEach(function (c) { self.col[c.key] = c; });

    var filterHtml = (cfg.filters || []).map(function (key) {
      var c = self.col[key];
      var vals = uniq(self.rows.map(function (r) { return c.get(r); })).filter(function (v) { return v != null && v !== ""; });
      vals.sort(c.filterSort || function (a, b) { return String(a).localeCompare(String(b)); });
      return '<select data-filter="' + key + '" aria-label="Filter by ' + esc(c.label) + '"><option value="">' +
        "All " + esc(c.plural || c.label.toLowerCase() + "s") + "</option>" + vals.map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(c.fmtFilter ? c.fmtFilter(v) : v) + "</option>";
      }).join("") + "</select>";
    }).join("");

    mount.innerHTML =
      '<div class="dt-toolbar">' +
      (cfg.search ? '<label class="dt-search">' + SEARCH_ICON + '<span class="visually-hidden">Search</span>' +
        '<input type="search" placeholder="' + esc(cfg.search) + '" data-role="q"></label>' : "") +
      filterHtml +
      '<div class="dt-menu"><button type="button" class="btn ghost" data-role="cols" aria-expanded="false">Columns</button>' +
      '<div class="dt-pop" data-role="pop" hidden></div></div>' +
      '<button type="button" class="btn ghost" data-role="csv">Download CSV</button>' +
      '<span class="dt-count" data-role="count" aria-live="polite"></span></div>' +
      '<div class="dt-chips" data-role="chips"></div>' +
      '<div class="table-scroll"><table><thead><tr></tr></thead><tbody></tbody></table></div>' +
      '<div class="dt-more" data-role="more"></div>';
    this.el = mount;
    this.part = function (role) { return mount.querySelector('[data-role="' + role + '"]'); };

    if (cfg.search) {
      var t;
      this.part("q").addEventListener("input", function (e) {
        clearTimeout(t);
        t = setTimeout(function () { self.q = e.target.value.trim().toLowerCase(); self.limit = cfg.page || 50; self.render(); }, 120);
      });
    }
    mount.querySelectorAll("[data-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var k = sel.getAttribute("data-filter");
        if (sel.value) self.filters[k] = sel.value; else delete self.filters[k];
        self.limit = cfg.page || 50;
        self.render();
      });
    });
    this.part("csv").addEventListener("click", function () { self.csv(); });
    var colsBtn = this.part("cols"), pop = this.part("pop");
    colsBtn.addEventListener("click", function () {
      var open = pop.hidden;
      pop.hidden = !open;
      colsBtn.setAttribute("aria-expanded", String(open));
      if (open) self.renderPop();
    });
    document.addEventListener("click", function (e) {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== colsBtn) {
        pop.hidden = true; colsBtn.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pop.hidden) { pop.hidden = true; colsBtn.setAttribute("aria-expanded", "false"); colsBtn.focus(); }
    });
    this.render();
  }

  DataTable.prototype.setRows = function (rows) {
    this.rows = rows;
    this.limit = this.cfg.page || 50;
    this.render();
  };
  DataTable.prototype.persist = function () {
    save("nbw.table." + this.cfg.id, { order: this.order, hidden: this.hidden, sort: this.sort });
  };
  DataTable.prototype.visible = function () {
    var self = this;
    return this.order.filter(function (k) { return self.hidden.indexOf(k) < 0; }).map(function (k) { return self.col[k]; });
  };
  DataTable.prototype.view = function () {
    var self = this, cols = this.cfg.columns, q = this.q;
    var rows = this.rows.filter(function (r) {
      for (var k in self.filters) { if (String(self.col[k].get(r)) !== self.filters[k]) return false; }
      if (!q) return true;
      return cols.some(function (c) {
        var v = c.text ? c.text(r) : c.get(r);
        return v != null && String(v).toLowerCase().indexOf(q) >= 0;
      });
    });
    if (this.sort) {
      var c = this.col[this.sort.key], dir = this.sort.dir === "asc" ? 1 : -1;
      rows = rows.slice().sort(function (a, b) {
        var x = c.get(a), y = c.get(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
        return String(x).localeCompare(String(y), "en", { numeric: true }) * dir;
      });
    }
    return rows;
  };
  DataTable.prototype.render = function () {
    var self = this, cols = this.visible(), rows = this.view();
    var head = this.el.querySelector("thead tr"), body = this.el.querySelector("tbody");
    head.innerHTML = cols.map(function (c) {
      var sorted = self.sort && self.sort.key === c.key;
      var arrow = sorted ? (self.sort.dir === "asc" ? "▲" : "▼") : "";
      return '<th scope="col" draggable="true" data-key="' + c.key + '" class="' + (c.num ? "num" : "") + '"' +
        (sorted ? ' aria-sort="' + (self.sort.dir === "asc" ? "ascending" : "descending") + '"' : "") +
        '><button type="button" class="th-btn" title="Sort; drag to reorder">' + esc(c.label) +
        '<span class="arrow" aria-hidden="true">' + arrow + "</span></button></th>";
    }).join("");
    var shown = rows.slice(0, this.limit);
    body.innerHTML = shown.length ? shown.map(function (r) {
      return "<tr>" + cols.map(function (c) {
        return '<td class="' + (c.num ? "num" : "") + '">' + (c.html ? c.html(r) : esc(c.get(r) == null ? "—" : c.get(r))) + "</td>";
      }).join("") + "</tr>";
    }).join("") : '<tr class="dt-empty"><td colspan="' + cols.length + '">' + esc(this.cfg.empty || "Nothing matches these filters.") + "</td></tr>";

    var count = this.part("count");
    count.textContent = rows.length === this.rows.length
      ? fmtInt(this.rows.length) + " rows"
      : fmtInt(rows.length) + " of " + fmtInt(this.rows.length) + " rows";

    var more = this.part("more");
    more.innerHTML = rows.length > this.limit
      ? '<button type="button" class="btn">Show ' + Math.min(this.cfg.page || 50, rows.length - this.limit) + " more</button>"
      : "";
    if (more.firstChild) more.firstChild.addEventListener("click", function () { self.limit += self.cfg.page || 50; self.render(); });

    var chips = this.part("chips");
    var active = Object.keys(this.filters).map(function (k) {
      var c = self.col[k], v = self.filters[k];
      return '<span class="chip">' + esc(c.label) + ": " + esc(c.fmtFilter ? c.fmtFilter(v) : v) +
        '<button type="button" data-clear="' + k + '" aria-label="Remove filter ' + esc(c.label) + '">×</button></span>';
    });
    if (this.q) active.push('<span class="chip">“' + esc(this.q) + '”<button type="button" data-clear="__q" aria-label="Clear search">×</button></span>');
    if (active.length > 1) active.push('<button type="button" class="btn ghost" data-clear="__all">Clear all</button>');
    chips.innerHTML = active.join("");
    chips.querySelectorAll("[data-clear]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-clear");
        if (k === "__q" || k === "__all") { self.q = ""; if (self.part("q")) self.part("q").value = ""; }
        if (k === "__all") self.filters = {};
        else if (k !== "__q") delete self.filters[k];
        self.el.querySelectorAll("[data-filter]").forEach(function (sel) { sel.value = self.filters[sel.getAttribute("data-filter")] || ""; });
        self.render();
      });
    });

    head.querySelectorAll("th").forEach(function (th) {
      var key = th.getAttribute("data-key");
      th.querySelector("button").addEventListener("click", function () {
        var c = self.col[key];
        if (self.sort && self.sort.key === key) self.sort = { key: key, dir: self.sort.dir === "asc" ? "desc" : "asc" };
        else self.sort = { key: key, dir: c.num || c.time ? "desc" : "asc" };
        self.persist();
        self.render();
      });
      th.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", key);
        e.dataTransfer.effectAllowed = "move";
        th.classList.add("dragging");
      });
      th.addEventListener("dragend", function () { th.classList.remove("dragging"); });
      th.addEventListener("dragover", function (e) {
        e.preventDefault();
        var r = th.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        th.classList.toggle("drop-after", after);
        th.classList.toggle("drop-before", !after);
      });
      th.addEventListener("dragleave", function () { th.classList.remove("drop-after", "drop-before"); });
      th.addEventListener("drop", function (e) {
        e.preventDefault();
        var from = e.dataTransfer.getData("text/plain"), after = th.classList.contains("drop-after");
        th.classList.remove("drop-after", "drop-before");
        if (!from || from === key) return;
        self.order.splice(self.order.indexOf(from), 1);
        self.order.splice(self.order.indexOf(key) + (after ? 1 : 0), 0, from);
        self.persist();
        self.render();
      });
    });
  };
  DataTable.prototype.renderPop = function () {
    var self = this, pop = this.part("pop");
    pop.innerHTML = '<div class="pop-title">Show, hide and order columns</div><ul>' + this.order.map(function (k, i) {
      var c = self.col[k], on = self.hidden.indexOf(k) < 0;
      return '<li><label><input type="checkbox" data-k="' + k + '"' + (on ? " checked" : "") + "> " + esc(c.label) + "</label>" +
        '<button type="button" class="mv" data-mv="' + k + '" data-d="-1" aria-label="Move ' + esc(c.label) + ' left"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
        '<button type="button" class="mv" data-mv="' + k + '" data-d="1" aria-label="Move ' + esc(c.label) + ' right"' + (i === self.order.length - 1 ? " disabled" : "") + ">▼</button></li>";
    }).join("") + '</ul><div class="pop-foot"><button type="button" class="btn ghost" data-reset>Reset columns</button></div>';
    pop.querySelectorAll("input[data-k]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var k = cb.getAttribute("data-k");
        if (cb.checked) self.hidden = self.hidden.filter(function (h) { return h !== k; });
        else if (self.visible().length > 1) self.hidden.push(k);
        else cb.checked = true;
        self.persist(); self.render();
      });
    });
    pop.querySelectorAll("[data-mv]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-mv"), i = self.order.indexOf(k), j = i + +b.getAttribute("data-d");
        if (j < 0 || j >= self.order.length) return;
        self.order[i] = self.order[j]; self.order[j] = k;
        self.persist(); self.render(); self.renderPop();
        var again = pop.querySelector('[data-mv="' + k + '"][data-d="' + b.getAttribute("data-d") + '"]');
        if (again && !again.disabled) again.focus();
      });
    });
    pop.querySelector("[data-reset]").addEventListener("click", function () {
      self.order = self.cfg.columns.map(function (c) { return c.key; });
      self.hidden = self.cfg.columns.filter(function (c) { return c.hidden; }).map(function (c) { return c.key; });
      self.sort = self.cfg.sort;
      self.persist(); self.render(); self.renderPop();
    });
  };
  DataTable.prototype.csv = function () {
    var cols = this.visible();
    downloadCsv(this.cfg.csvName, [cols.map(function (c) { return c.csvLabel || c.label; })].concat(this.view().map(function (r) {
      return cols.map(function (c) { return c.csv ? c.csv(r) : c.get(r); });
    })));
  };

  function csvCell(v) {
    /* Derived numbers (hours, shares) carry float noise such as 25.334999999999997. */
    if (typeof v === "number" && isFinite(v) && v !== Math.round(v)) v = Number(v.toFixed(6));
    var s = v == null ? "" : String(v);
    /* Text that a spreadsheet would read as a formula is prefixed with an apostrophe. */
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(name, rows) {
    var text = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
    var url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    (document.querySelector("dialog[open]") || document.body).appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- derived views of the summary ---------- */

  function imbalanceGroups(s) {
    return (s.groups || []).filter(function (g) { return g.data === "imbalance" && g.last7 && g.last7.n > 0; });
  }
  function reserveGroups(s) {
    return (s.groups || []).filter(function (g) { return g.data !== "imbalance"; });
  }
  /* Per zone, the source category with the lowest median delay. */
  function fastestByZone(imb) {
    var by = {};
    imb.forEach(function (g) {
      var cur = by[g.zone];
      if (g.last7.p50 != null && (!cur || g.last7.p50 < cur.last7.p50)) by[g.zone] = g;
    });
    return by;
  }

  /* Delays are accurate to about one check, and the sources are checked at different moments
     of each quarter-hour. A source counts as first in a zone only when it leads the next
     one by LEVEL_MIN minutes or more; a smaller gap is level, not a lead. */
  var LEVEL_MIN = 5;
  function clearlyFirst(imb, fastest) {
    var out = {};
    Object.keys(fastest).forEach(function (z) {
      var f = fastest[z];
      var next = imb.filter(function (g) { return g.zone === z && g !== f && g.last7.p50 != null; })
        .map(function (g) { return g.last7.p50; });
      out[z] = !next.length || Math.min.apply(null, next) - f.last7.p50 >= LEVEL_MIN;
    });
    return out;
  }

  /* "7–10 h", from slowest-interval delays in minutes. */
  function hoursSpan(lo, hi) {
    var a = Math.round(lo / 60), b = Math.round(hi / 60);
    return a === b ? "about " + a + " h" : a + "–" + b + " h";
  }
  /* The slowest 15-minute interval of several sources can be the very same interval: the
     groups whose slowest interval started at one moment, at least 6 hours late, in at least
     two source categories. The collector adds last7.max_start; without it nothing is shared. */
  function sharedSlowest(imb) {
    var by = {};
    imb.forEach(function (g) {
      var l = g.last7;
      if (!validTime(l.max_start) || !(l.max >= 360)) return;
      (by[l.max_start] = by[l.max_start] || []).push(g);
    });
    var best = null;
    Object.keys(by).forEach(function (start) {
      var gs = by[start];
      if (gs.length < 2 || uniq(gs.map(function (g) { return cat(g.source); })).length < 2) return;
      var top = Math.max.apply(null, gs.map(function (g) { return g.last7.max; }));
      if (!best || gs.length > best.groups.length || (gs.length === best.groups.length && top > best.top)) {
        best = { start: start, groups: gs, top: top };
      }
    });
    if (!best) return null;
    var maxes = best.groups.map(function (g) { return g.last7.max; });
    var bySrc = {};
    best.groups.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g.zone); });
    best.names = Object.keys(bySrc).sort(function (a, b) { return CAT_ORDER.indexOf(cat(a)) - CAT_ORDER.indexOf(cat(b)) || (SRC_LABEL[a] < SRC_LABEL[b] ? -1 : 1); }).map(function (k) {
      return SRC_LABEL[k] + " (" + zoneRange(bySrc[k]) + ")";
    });
    best.span = hoursSpan(Math.min.apply(null, maxes), Math.max.apply(null, maxes));
    /* "Every source" only when every imbalance series with data has this as its slowest
       interval; otherwise the sources and zones that share it are named without it. */
    best.every = imb.filter(function (g) { return g.last7 && g.last7.n > 0; })
      .every(function (g) { return g.last7.max_start === best.start; });
    best.at = dateTime(best.start) + " " + tzName(best.start);
    return best;
  }

  /* Imbalance revisions logged in the window to prices first seen before it. The share of
     the window's first prices changed so far cannot include them, so the page says how long
     after publication they came. Null when there are none. */
  function lateRevisions(s, revs) {
    var from = Date.parse(s.generated_at) - 7 * 86400000;
    var lags = (revs || []).filter(function (r) {
      return r.data === "imbalance" && !isCompletion(r) && inZones(r.zone) && validTime(r.first_published_at) &&
        validTime(r.revised_at) && Date.parse(r.first_published_at) < from;
    }).map(function (r) { return (Date.parse(r.revised_at) - Date.parse(r.first_published_at)) / 86400000; });
    if (!lags.length) return null;
    var lo = Math.round(Math.min.apply(null, lags)), hi = Math.round(Math.max.apply(null, lags));
    return { n: lags.length, span: (lo === hi ? lo : lo + "–" + hi) + (hi === 1 ? " day" : " days") };
  }

  /* Imbalance prices old enough to have been revised: those first seen on closed UTC days
     that ended at least MATURE_DAYS ago. The collector keeps a day's "revised" count current
     when a later revision reaches it, so this is the share of prices watched that long.
     Null until collection is old enough to have such a day. */
  var MATURE_DAYS = 14;
  function matureCohort(s) {
    /* Every imbalance series with history counts, including one with no timed price this week. */
    var groups = (s.groups || []).filter(function (g) { return g.data === "imbalance" && g.last7; });
    var t = Date.parse(s.generated_at);
    if (isNaN(t)) return null;
    var cut = new Date(t - MATURE_DAYS * 86400000).toISOString().slice(0, 10);
    var out = { published: 0, revised: 0, from: null, to: null, series: [] };
    groups.forEach(function (g) {
      var pub = 0, rev = 0;
      (g.daily || []).forEach(function (d) {
        if (typeof d.day !== "string" || !(d.day < cut) || !(d.published > 0)) return;
        pub += d.published; rev += d.revised || 0;
        if (!out.from || d.day < out.from) out.from = d.day;
        if (!out.to || d.day > out.to) out.to = d.day;
      });
      if (pub) out.series.push({ g: g, published: pub, revised: rev });
      out.published += pub; out.revised += rev;
    });
    if (!out.published) return null;
    out.days = dayRange(out.from, out.to);
    return out;
  }
  /* "24–27 Oct" or "28 Oct – 3 Nov", from two YYYY-MM-DD days. */
  function dayRange(a, b) {
    var f = function (day, month) {
      return new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", month ? { day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });
    };
    if (a === b) return f(a, true);
    return a.slice(0, 7) === b.slice(0, 7) ? f(a, false) + "–" + f(b, true) : f(a, true) + " – " + f(b, true);
  }
  /* Prices that first appeared more than 48 hours after their interval ended. They are seen
     only by the daily check, so they are counted, not timed. `known` is false for data
     files from before the collector counted them. */
  function lateSummary(imb) {
    var known = imb.some(function (g) { return g.last7.late != null; });
    var gs = imb.filter(function (g) { return g.last7.late > 0; });
    var bySrc = {};
    gs.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g.zone); });
    var worst = Math.max.apply(null, gs.map(function (g) { return g.last7.late_max_h || 0; }).concat([0]));
    return {
      known: known, n: sum(gs.map(function (g) { return g.last7.late; })), worst: worst,
      names: Object.keys(bySrc).sort().map(function (k) { return SRC_LABEL[k] + " (" + zoneRange(bySrc[k]) + ")"; })
    };
  }
  function lateSentence(late) {
    return "<b>" + fmtInt(late.n) + "</b> price" + (late.n === 1 ? "" : "s") + " first appeared more than 48 hours late, at " +
      esc(joinList(late.names)) + (late.worst ? ", up to " + fmtHours(late.worst) + " after the interval ended" : "") +
      ". " + (late.n === 1 ? "It is" : "They are") + " counted, not timed.";
  }

  /* Minutes from the start of delivery to the first price when the collector measures it
     (from_start_*), otherwise from the end of each quarter-hour (p50, p95). */
  /* The basis is decided once for all reserve series (state.leadStart, set per render), so a
     series without the value is left out rather than mixed in on the other basis. */
  function startDelay(g, q) {
    return state.leadStart ? g.last7["from_start_" + q] : g.last7[q];
  }
  function leadFromStart() { return !!state.leadStart; }

  /* ---------- sections ---------- */

  /* The statistics use a rolling 7-day window. Until 7 days have been collected the window
     holds less than that, so the copy names the history the figures actually rest on. */
  function coverage(s) {
    var since = s.collecting_since ? Date.parse(s.collecting_since) : NaN;
    var hours = (Date.parse(s.generated_at) - since) / 3600000;
    if (isNaN(hours)) return { hours: null, full: false, span: null, since: null, label: "data collected so far" };
    hours = Math.max(0, hours);
    var h = Math.round(hours);
    var span = hours < 1 ? "less than an hour" : hours < 48 ? h + (h === 1 ? " hour" : " hours")
      : (hours / 24).toFixed(1).replace(/\.0$/, "") + " days";
    var full = hours >= 168;
    return { hours: hours, full: full, span: span, since: s.collecting_since,
      label: full ? "last 7 days" : hours < 1 ? "first hour of collection" : "first " + span + " of collection" };
  }

  function renderCoverage(s, v) {
    var c = state.cov = coverage(s);
    document.querySelectorAll("[data-window]").forEach(function (el) { el.textContent = c.label; });
    var imb = imbalanceGroups(v);
    var pub = sum(imb.map(function (g) { return g.last7.published || 0; }));
    var sample = pub ? fmtInt(pub) + " imbalance prices first seen in " + imb.length + " zone and source series" : "";
    var since = c.since ? longDate(c.since) + ", " +
      fmtTime(c.since, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " " + tzName(c.since) : "";
    var seen = " Times are when the collector first saw each price, checking imbalance prices every 15 minutes and reserve prices every hour.";
    /* Two scopes, kept apart on the page: the published figures are a rolling 7-day window,
       while the collector keeps every version since collection started. */
    var end = s.generated_at, start = new Date(Date.parse(end) - 7 * 86400000).toISOString();
    if (c.since && !c.full) start = c.since;
    var at = function (iso) { return longDate(iso) + ", " + fmtTime(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " " + tzName(iso); };
    var total = s.observations_total;
    $("scope").innerHTML =
      "<div><dt>Full collected history</dt><dd>" + (c.since
        ? "Collecting since <b>" + esc(at(c.since)) + "</b> (" + esc(c.span) + ")"
        : "Collection start not stated in the data") +
        (total != null ? " · " + fmtInt(total) + " observations on record" : "") +
        ". Every version is kept; this page publishes only the 7-day window and up to 30 closed UTC days.</dd></div>" +
      "<div><dt>Figures on this page</dt><dd>" + (c.full ? "Rolling 7-day window" : "Everything collected so far, less than the 7-day window") +
        ": <b>" + esc(at(start)) + "</b> to <b>" + esc(at(end)) + "</b>" +
        (sample ? " · " + sample : "") + ".</dd></div>";
    $("sample-note").innerHTML = c.full
      ? seen.trim()
      : !c.since
        ? "<b>Early observations, not established patterns.</b> The data does not say when collection started, so how much history the figures rest on is unknown" +
          (sample ? " (" + sample + ")" : "") + "." + seen
        : "<b>Early observations, not established patterns.</b> Collection started on " + esc(since) + ", so the figures below rest on only " +
          c.span + " of data" + (sample ? " (" + sample + ")" : "") + ", not a full 7-day window." + seen;
    /* revisions.json keeps only the newest entries (the collector caps it at 500), so the log
       and the charts built from it can cover less than the window the summary counts. */
    var logged = state.revisions.length, counted = sum((s.groups || []).map(function (g) { return (g.last7 && g.last7.revisions) || 0; }));
    var oldest = logged ? state.revisions.reduce(function (m, r) { return r.revised_at < m ? r.revised_at : m; }, state.revisions[0].revised_at) : null;
    var capped = logged >= 500 && oldest;
    /* Newer logs say what they keep: every imbalance change of the window, then the newest others. */
    var kp = state.kept, count = function (n) { return typeof n === "number" && isFinite(n) && n >= 0 && n === Math.floor(n); };
    var keptText = !(kp && ["imbalance", "imbalance_total", "other", "other_total"].every(function (k) { return count(kp[k]); })) ? null
      : !(kp.other < kp.other_total || kp.imbalance < kp.imbalance_total) ? ""
      : "The log keeps " + (kp.imbalance === kp.imbalance_total
          ? "every imbalance price change in the " + state.cov.label + " (" + fmtInt(kp.imbalance) + ")"
          : "the newest " + fmtInt(kp.imbalance) + " of " + fmtInt(kp.imbalance_total) + " imbalance price changes") +
        " and the newest " + fmtInt(kp.other) + " of " + fmtInt(kp.other_total) + " reserve price changes" +
        (validTime(kp.other_since) ? ", back to " + dateTime(kp.other_since) + " " + tzName(kp.other_since) : "") +
        ". The revision log, its CSV and the charts built from it cover only those entries.";
    document.querySelectorAll("[data-revcap]").forEach(function (el) {
      el.textContent = keptText != null ? keptText : capped ? "The log keeps only the newest " + fmtInt(logged) + " entries, back to " + dateTime(oldest) + " " + tzName(oldest) +
        ", while " + fmtInt(counted) + " changes were counted in the window. The revision log, its CSV and the charts built from it cover only those entries." : "";
    });
    var currency = sum((s.groups || []).map(function (g) { return (g.last7 && g.last7.currency_recalculations) || 0; }));
    document.querySelectorAll("[data-currency]").forEach(function (el) {
      el.textContent = currency ? "Energi Data Service also recalculated its Danish-krone price " + fmtInt(currency) +
        (currency === 1 ? " time" : " times") + " in the window with the euro price unchanged. Those currency recalculations are not revisions and are not in the log." : "";
    });
    /* Replaces the page's own sentence, which stays only for readers without the data. */
    $("coverage-note").textContent = !c.since ? "The statistics use a rolling 7-day window and the daily view covers up to 30 closed UTC days. The data does not say when collection started, so how much of the window is filled is unknown."
      : c.full ? "Collection started on " + since + " and every version since then is kept. The figures here use only the rolling 7-day window, which is full; the daily view covers up to 30 closed UTC days."
      : "Collection started on " + since + ". The current data covers " + c.span + ", so the 7-day window is not yet full and every figure on this page comes from that shorter sample; the daily view covers up to 30 closed UTC days.";
  }

  function isStale(s) { return Date.now() - Date.parse(s.generated_at) > STALE_MS; }

  function renderStatus(s) {
    var stale = isStale(s);
    $("live-dot").classList.toggle("stale", stale);
    $("status-line").innerHTML = (stale ? "Delayed" : "Live") + " · updated " +
      '<time datetime="' + esc(s.generated_at) + '">' +
      esc(fmtTime(s.generated_at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " " + tzName(s.generated_at)) +
      "</time> (" + esc(relTime(s.generated_at)) + ")" +
      (validTime(s.collecting_since) ? " · collecting since " + esc(longDate(s.collecting_since)) : "");
    var b = $("stale-banner");
    if (stale) {
      b.firstChild.textContent = "This data was generated " + relTime(s.generated_at) +
        "; it normally refreshes every 15 minutes, so the newest prices may be missing.";
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  function renderStats(s) {
    var imb = imbalanceGroups(s), tiles = [];
    var byCat = {};
    imb.forEach(function (g) { (byCat[cat(g.source)] = byCat[cat(g.source)] || []).push(g); });
    var fastest = fastestByZone(imb), zones = Object.keys(fastest);
    if (zones.length) {
      var wins = {}, clear = clearlyFirst(imb, fastest);
      zones.forEach(function (z) { if (!clear[z]) return; var c = cat(fastest[z].source); wins[c] = (wins[c] || 0) + 1; });
      var lead = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; })[0];
      var level = zones.filter(function (z) { return !clear[z]; }).length;
      /* Which source is first, zone by zone, as one segmented bar; level zones are grey. */
      var bar = '<span class="tile-bar" aria-hidden="true">' + CAT_ORDER.filter(function (c) { return wins[c]; }).map(function (c) {
        return '<i style="flex:' + wins[c] + ";background:" + catColor(c) + '" title="' + esc(CAT_LABEL[c]) + " first in " + wins[c] + '"></i>';
      }).join("") + (level ? '<i style="flex:' + level + ';background:var(--muted)" title="Level in ' + level + '"></i>' : "") + "</span>";
      tiles.push(["First price seen after", fmtMin(median(zones.map(function (z) { return fastest[z].last7.p50; }))),
        "Median zone · " + (lead ? CAT_LABEL[lead] + " first in " + wins[lead] + " of " + zones.length : "no source clearly first") +
        (lead && level ? " · level in " + level : ""), bar]);
    }
    var es = (byCat.esett || []).map(function (g) { return g.last7.p50; }).filter(function (v) { return v != null; });
    if (es.length) {
      var lo = Math.round(Math.min.apply(null, es)), hi = Math.round(Math.max.apply(null, es));
      tiles.push(["eSett prices seen after", (lo === hi ? lo : lo + "–" + hi) + "<small>min</small>", "Typical, depending on the zone"]);
    }
    var pub = sum(imb.map(function (g) { return g.last7.published || 0; }));
    var rev = sum(imb.map(function (g) { return g.last7.revised || 0; }));
    var mature = matureCohort(s);
    if (mature) {
      /* The share that means something: prices watched long enough to have been revised. */
      tiles.push(["First prices changed later", fmtPct(mature.revised / mature.published, 1),
        fmtInt(mature.revised) + " of " + fmtInt(mature.published) + " imbalance prices first seen " + mature.days + ", watched " + MATURE_DAYS + " days or more",
        '<span class="tile-meter" aria-hidden="true"><i style="width:' + Math.max(mature.revised ? 2 : 0, Math.round(mature.revised / mature.published * 100)) + '%"></i></span>']);
    } else if (pub) {
      /* A price first seen in the window has had less than the window to change. When the
         changes logged came later than that, the tile says so next to the share. */
      var late = lateRevisions(s, state.revisions);
      tiles.push(["First prices changed so far", fmtPct(rev / pub, 1), fmtInt(rev) + " of " + fmtInt(pub) + " imbalance prices" +
        (late ? " · the " + fmtInt(late.n) + (late.n === 1 ? " change" : " changes") + " logged came " + late.span + " after publication" : ""),
        '<span class="tile-meter" aria-hidden="true"><i style="width:' + Math.max(rev ? 2 : 0, Math.round(rev / pub * 100)) + '%"></i></span>']);
    }
    var revisions = sum((s.groups || []).map(function (g) { return (g.last7 && g.last7.revisions) || 0; }));
    /* The same revision can be logged once per source; when the log is known to hold every
       imbalance revision of the window, the tile counts each revised price once and says
       how many records that rests on. Logs without kept counts keep the record count.
       No source says why it changed a price, so the tile says "revised", not "corrected". */
    var kp = state.kept, head = ["Price changes logged", revisions, ""];
    if (kp && typeof kp.imbalance === "number" && kp.imbalance === kp.imbalance_total) {
      var seen = {}, srcs = {}, logged = 0, revisedOnce = 0;
      state.revisions.filter(function (r) { return inZones(r.zone); }).forEach(function (r) {
        if (isCompletion(r)) return;
        logged++;
        srcs[r.source] = true;
        if (r.data === "imbalance") {
          var key = [r.zone, r.interval_start, r.old, r.new].join("|");
          if (seen[key]) return;
          seen[key] = true;
        }
        revisedOnce++;
      });
      var m = Object.keys(srcs).length;
      head = ["Prices revised", revisedOnce,
        logged !== revisedOnce ? fmtInt(logged) + " changes logged across " + m + " source" + (m === 1 ? "" : "s") + " · " : ""];
    }
    var p = s.polls_24h || {}, total = (p.ok || 0) + (p.skipped || 0) + (p.error || 0);
    var health = total ? (p.ok / total >= 0.98 ? "up" : p.ok / total >= 0.9 ? "amber" : "down") : "";
    var win = state.cov.label.charAt(0).toUpperCase() + state.cov.label.slice(1);
    /* When the collector separates them, completed auctions are named, not counted in the figure. */
    var c7 = s.completions_7d || {};
    var done = typeof c7.market_intervals === "number" && isFinite(c7.market_intervals) ? c7.market_intervals : null;
    /* One completion per joint-market price, in the unit the source published (see ru). */
    if (done != null) done = ru().of(done);
    var auction = done == null ? "" : " · plus " + fmtInt(done) + (ru().div === 4 ? " hourly reserve price" + (done === 1 ? "" : "s")
      : " reserve quarter-hour" + (done === 1 ? "" : "s")) + " completed by a later auction";
    /* The check counts come from the same file, so a stalled collector cannot vouch for itself. */
    var stale = state.summary && isStale(state.summary);
    if (stale) {
      tiles.push([head[0], fmtInt(head[1]), head[2] + win + auction,
        '<span class="tile-health"><span class="dot down"></span>No new data since ' + esc(dateTime(s.generated_at) + " " + tzName(s.generated_at)) + "</span>"]);
    } else {
      tiles.push([head[0], fmtInt(head[1]), head[2] + win + (total ? " · " + fmtPct(p.ok / total) + " of checks OK in the last 24 h" : "") + auction,
        health ? '<span class="tile-health"><span class="dot ' + health + '"></span>Collector ' +
          (health === "up" ? "healthy" : health === "amber" ? "partly failing" : "failing") + "</span>" : ""]);
    }
    $("stats").innerHTML = tiles.map(function (t) {
      return '<div class="stat"><dt>' + esc(t[0]) + '</dt><dd><span class="v">' + t[1] + "</span>" + (t[3] || "") +
        '<span class="s">' + esc(t[2]) + "</span></dd></div>";
    }).join("");
  }

  function renderFindings(s, revs) {
    var imb = imbalanceGroups(s), out = [];
    var fastest = fastestByZone(imb), zones = Object.keys(fastest);
    var wins = {}, clear = clearlyFirst(imb, fastest);
    zones.forEach(function (z) { if (!clear[z]) return; var c = cat(fastest[z].source); wins[c] = (wins[c] || 0) + 1; });
    var lead = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; })[0];
    if (lead) {
      /* Only the zones where this category is clearly first: its delay elsewhere is not a lead. */
      var leadP50 = zones.filter(function (z) { return clear[z] && cat(fastest[z].source) === lead; }).map(function (z) { return fastest[z].last7.p50; });
      var lo = Math.round(Math.min.apply(null, leadP50)), hi = Math.round(Math.max.apply(null, leadP50));
      var level = zones.filter(function (z) { return !clear[z]; });
      out.push("The " + term("imbalance", "imbalance price") + " usually shows up first on <b>" + esc(CAT_LABEL[lead]) +
        "</b>: in <b>" + wins[lead] + " of " + zones.length + "</b> " + term("zone", "price zones") + ", about <b>" +
        (lo === hi ? lo : lo + "–" + hi) + " minutes</b> after each 15 minutes end." +
        (level.length ? " In " + esc(zoneRange(level)) + " the first two sources are level, within " + LEVEL_MIN + " minutes of each other." : ""));
    }
    var gaps = imb.filter(function (g) { return g.source === "esett" && fastest[g.zone] && fastest[g.zone].source !== "esett"; })
      .map(function (g) { return g.last7.p50 - fastest[g.zone].last7.p50; });
    if (gaps.length) {
      out.push(term("esett", "eSett") + ", where the money is settled, shows the same prices <b>" +
        Math.round(Math.min.apply(null, gaps)) + "–" + Math.round(Math.max.apply(null, gaps)) + " minutes later</b>.");
    }
    var shared = sharedSlowest(imb);
    if (shared) {
      out.push("One 15-minute price, the one starting <b>" + esc(shared.at) + "</b>, first appeared <b>" + esc(shared.span) +
        "</b> after it ended at " + (shared.every ? "<b>every source</b>: " : "") + esc(joinList(shared.names)) +
        ", so the delay began before publication rather than at one publisher." +
        (shared.every || lateSummary(imb).known ? "" : " A source missing from that list was not necessarily faster: a price more than 48 hours late is not timed."));
    }
    var lateImb = lateSummary(imb);
    if (lateImb.n) {
      out.push(lateSentence(lateImb));
    }
    var top = imb.filter(function (g) { return g.last7.published >= 20 && g.last7.revised_share > 0; })
      .sort(function (a, b) { return b.last7.revised_share - a.last7.revised_share; })[0];
    /* With enough history the finding is about prices watched long enough to have been
       revised; the 7-day share below is only the fallback. */
    var mature = matureCohort(s);
    if (mature) {
      out.push(mature.revised
        ? "Of the " + fmtInt(mature.published) + " first prices seen " + esc(mature.days) + ", each watched for " + MATURE_DAYS +
          " days or more, <b>" + fmtPct(mature.revised / mature.published, 1) + "</b> (" + fmtInt(mature.revised) + ") were changed later."
        : "None of the " + fmtInt(mature.published) + " first prices seen " + esc(mature.days) + ", each watched for " + MATURE_DAYS +
          " days or more, has been changed since.");
    } else if (top) {
      var clean = CAT_ORDER.filter(function (c) {
        var gs = imb.filter(function (g) { return cat(g.source) === c; });
        return gs.length && gs.every(function (g) { return !g.last7.revisions; });
      }).map(function (c) { return CAT_LABEL[c]; });
      /* From the counts: revised_share is rounded to 4 decimals, too coarse for "1 in N". */
      var share = top.last7.published ? top.last7.revised / top.last7.published : top.last7.revised_share;
      var plain = "About " + simpleFraction(share);
      out.push("<b>" + plain + "</b> (" + fmtPct(share) + ", " + fmtInt(top.last7.revised) + " of " + fmtInt(top.last7.published) + ") of the first prices " + esc(SRC_LABEL[top.source]) + " showed for <b>" +
        esc(country(top.zone)) + (country(top.zone) !== top.zone ? " (" + esc(top.zone) + ")" : "") + "</b> have been changed so far." +
        (clean.length ? " " + esc(clean.join(" and ")) + " did not change any." : ""));
    }
    var zeros = revs.filter(function (r) { return r.source === "esett" && r.kind === "changed" && r.old === 0; });
    var esRevs = revs.filter(function (r) { return r.source === "esett" && r.data === "imbalance"; });
    if (zeros.length >= 3) {
      var zz = zoneRange(zeros.map(function (r) { return r.zone; }));
      var lead0 = zeros.length === esRevs.length ? "In all of the changes to eSett prices" : zeros.length * 2 > esRevs.length ? "In most of the changes to eSett prices" : "In some of the changes to eSett prices";
      out.push(lead0 + ", the value replaced was <b>0.00</b> (" +
        fmtInt(zeros.length) + " of " + fmtInt(esRevs.length) + " changes in the log, " + esc(zz) + ").");
    }
    var res = reserveGroups(s).filter(function (g) { return rePriced(g) > 0 && !changedAfterDelivery(g); });
    if (res.length) {
      var bySrc = {};
      res.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g); });
      var src = Object.keys(bySrc).sort(function (a, b) {
        return sum(bySrc[b].map(rePriced)) - sum(bySrc[a].map(rePriced));
      })[0];
      var gs = bySrc[src], n = ru().of(sum(gs.map(rePriced)));
      var products = uniq(gs.map(function (g) { return g.data.split(" ")[0]; }));
      var leadMin = median(gs.map(function (g) { return g.last7.p50; }).filter(function (v) { return v != null && v < 0; }));
      var per = perZoneCompletions(gs), rev = ru().of(zoneSum(gs));
      var lag = per ? lagOf(gs, "completion_lag_p50_h") : lagOf(gs, "lag_p50_h");
      var note = per ? "completed by a later auction " + per + (rev ? "; " + fmtInt(rev) + " " + ru().zone + " revised" : "")
        : fmtInt(n) + " " + ru().zone + " re-priced";
      out.push("Prices for " + term("reserve", "standby power") + " (" + esc(products.join(" and ")) + " in " +
        esc(zoneRange(gs.map(function (g) { return g.zone; }))) + ") come out" +
        (leadMin != null ? " about <b>" + fmtHours(-leadMin / 60) + " before delivery</b>" : " ahead of delivery") +
        " and are then updated" + (lag != null ? " about <b>" + fmtHours(lag) + "</b> later," : "") +
        " when the next " + term("auction", "auction") + " clears (" + note + ").");
    }
    $("findings").innerHTML = out.length ? out.map(function (h) { return "<li><span>" + h + "</span></li>"; }).join("")
      : "<li><span>Not enough data yet: findings appear after the first full day of collection.</span></li>";
    bindTerms($("findings"));
  }

  /* One worked example under the chart: the zone where sources differ the most. */
  function renderHowTo(s) {
    var imb = imbalanceGroups(s), best = null;
    uniq(imb.map(function (g) { return g.zone; })).forEach(function (z) {
      var gs = imb.filter(function (g) { return g.zone === z && g.last7.p50 != null; })
        .sort(function (a, b) { return a.last7.p50 - b.last7.p50; });
      if (gs.length < 2) return;
      var gap = gs[gs.length - 1].last7.p50 - gs[0].last7.p50;
      if (!best || gap > best.gap) best = { zone: z, fast: gs[0], slow: gs[gs.length - 1], gap: gap };
    });
    if (!best) { $("delay-howto").innerHTML = ""; return; }
    var f = best.fast, w = best.slow;
    $("delay-howto").innerHTML = "<b>How to read it:</b> in " + esc(best.zone) + " (" + esc(country(best.zone)) + "), " +
      swatch(cat(f.source)) + " " + esc(SRC_LABEL[f.source]) + " usually has the price <b>" + fmtMin(f.last7.p50) +
      "</b> after the 15 minutes end. " + swatch(cat(w.source)) + " " + esc(SRC_LABEL[w.source]) + " takes <b>" +
      fmtMin(w.last7.p50) + "</b>, and up to " + fmtMin(w.last7.p95) + " on a bad day.";
  }

  /* ---------- right now ---------- */

  function renderBoard(s) {
    var now = (s.now || []).filter(function (e) { return inZones(e.zone); });
    var table = $("board");
    if (!now.length) {
      table.innerHTML = '<tbody><tr class="dt-empty"><td>No recent price in the selected zones.</td></tr></tbody>';
      $("board-legend").innerHTML = ""; $("board-note").textContent = ""; $("board-asof").textContent = "";
      return;
    }
    $("board-asof").textContent = "EUR/MWh · As of " + fmtTime(s.generated_at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " " + tzName(s.generated_at);
    var cats = CAT_ORDER.filter(function (c) { return now.some(function (e) { return cat(e.source) === c; }); });
    var p95 = {};
    (s.groups || []).forEach(function (g) { if (g.data === "imbalance" && g.last7) p95[g.source + "|" + g.zone] = g.last7.p95; });
    var zones = uniq(now.map(function (e) { return e.zone; })).sort(function (a, b) { return zoneIndex(a) - zoneIndex(b); });
    var zeroSeen = false;
    var head = '<thead><tr><th scope="col" class="zone-col"><span class="th-pad">Zone</span></th>' + cats.map(function (c) {
      return '<th scope="col"><span class="th-pad"><span class="src">' + swatch(c) + esc(CAT_LABEL[c]) + "</span></span></th>";
    }).join("") + "</tr></thead>";
    var body = zones.map(function (z) {
      var entries = now.filter(function (e) { return e.zone === z; });
      var newest = entries.reduce(function (m, e) { return !m || e.interval_start > m.interval_start ? e : m; }, null);
      return '<tr class="zd-row" data-zone="' + esc(z) + '"><td class="zone-col"><button type="button" class="zd-open" aria-label="Open ' +
        esc(z) + ' details"><b>' + esc(z) + "</b><span>" + esc(country(z)) + '</span><span class="zd-more">Details ›</span></button></td>' + cats.map(function (c) {
        var e = entries.filter(function (x) { return cat(x.source) === c; })[0];
        var lab = ' data-label="' + esc(CAT_LABEL[c]) + '"';
        if (!e) return '<td class="muted"' + lab + ">—</td>";
        var zero = e.price === 0 && e.source === "esett";
        zeroSeen = zeroSeen || zero;
        var limit = p95[e.source + "|" + z];
        var late = limit != null && e.minutes_since_end > limit + 30;
        var isNewest = entries.length > 1 && e === newest && entries.filter(function (x) { return x.interval_start === e.interval_start; }).length === 1;
        return "<td" + lab + '><div class="px-line"><span class="px">' + fmtPrice(e.price) + (zero ? "*" : "") + "</span>" +
          chg(e.prev_price, e.price, { minBase: 10 }) + "</div>" + sparkline(e.recent) +
          '<span class="px-sub">For ' + esc(fmtTime(e.interval_start, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })) +
          " · " + esc(fmtDur(e.minutes_since_end)) + " ago" + (cat(e.source) === "tso" ? " · " + esc(SRC_LABEL[e.source]) : "") + "</span>" +
          (isNewest ? '<span class="badge newest">Newest</span> ' : "") +
          (late ? '<span class="badge late" title="Older than this source usually is">⚠ Later than usual</span>' : "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
    table.innerHTML = head + "<tbody>" + body + "</tbody>";
    $("board-legend").innerHTML = "";
    $("board-note").textContent = (zeroSeen ? "* In this data, eSett values of 0.00 have often been replaced by a different value later. " : "") +
      "Click a zone for its last 7 days from every source. " +
      "The change is against the interval before; the line shows up to the last 4 hours. " +
      "Times are when each 15-minute interval started, and how long ago it ended. " +
      "“Later than usual” means the newest price is more than 30 minutes older than this source’s 95th percentile.";
  }

  function renderRecent(s, revs) {
    var since = Date.parse(s.generated_at) - 3 * 3600000;
    var recent = revs.filter(function (r) { return inZones(r.zone) && Date.parse(r.revised_at) >= since; })
      .sort(function (a, b) { return a.revised_at < b.revised_at ? 1 : -1; });
    /* One row per change: a completion in a joint market is one event, listed once with its zones. */
    var jointKey = function (r) { return [r.source, r.data, r.interval_start, r.revised_at, r.old, r.new].join("|"); };
    var zonesOf = {};
    recent.forEach(function (r) { if (isCompletion(r)) (zonesOf[jointKey(r)] = zonesOf[jointKey(r)] || []).push(r.zone); });
    var events = dedupeJoint(recent);
    var shown = events.slice(0, 8);
    var hm = function (iso) { return fmtTime(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); };
    $("recent").innerHTML = shown.length ? shown.map(function (r) {
      return '<li><span class="t">' + esc(hm(r.revised_at)) + "</span><span>" + srcCell(r.source) + " · " + esc(isCompletion(r) ? zoneRange(zonesOf[jointKey(r)]) : r.zone) +
        ' <span class="muted">' + esc(r.data === "imbalance" ? "for " + hm(r.interval_start) : r.data) + "</span>" +
        (isCompletion(r) ? ' <span class="tag completed">' + esc(CAT_LABEL.completed) + "</span>" : "") + "</span>" +
        '<span class="v"><span class="muted">' + fmtPrice(r.old) + " →</span> " +
        (r.new == null ? '<span class="tag withdrawn">Withdrawn</span>' : "<b>" + fmtPrice(r.new) + "</b> " + chg(r.old, r.new, { plain: true })) + "</span></li>";
    }).join("") + (events.length > shown.length ? '<li class="more">+' + (events.length - shown.length) + " more in the revision log</li>" : "")
      : '<li class="more">No price changed in the last 3 hours' + (state.zones ? " in the selected zones" : "") + ".</li>";
  }

  function renderDelay(s) {
    var imb = imbalanceGroups(s);
    var zones = uniq(imb.map(function (g) { return g.zone; })).sort(function (a, b) { return zoneIndex(a) - zoneIndex(b); });
    var cats = CAT_ORDER.filter(function (c) { return imb.some(function (g) { return cat(g.source) === c; }); });
    legend($("delay-legend"), cats, '<span><svg width="24" height="10" aria-hidden="true"><line x1="2" x2="20" y1="5" y2="5" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/><line x1="20" x2="20" y1="1" y2="9" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/></svg>95% seen by</span>');
    var rows = zones.map(function (z) {
      var gs = imb.filter(function (g) { return g.zone === z; })
        .sort(function (a, b) { return CAT_ORDER.indexOf(cat(a.source)) - CAT_ORDER.indexOf(cat(b.source)); });
      var tip = '<div class="t-title">' + esc(z) + " · " + esc(country(z)) + "</div>" + gs.map(function (g) {
        return tipRow(cat(g.source), SRC_LABEL[g.source], fmtMin(g.last7.p50) + ' <span class="muted">/ ' + fmtMin(g.last7.p95) + "</span>");
      }).join("") + '<div class="t-sub">Median / 95th percentile, minutes after the interval. ' +
        "Slowest: " + gs.map(function (g) { return esc(SRC_LABEL[g.source]) + " " + fmtDur(g.last7.max); }).join(", ") + ".</div>";
      return {
        group: country(z), label: z, tip: tip,
        aria: z + ": " + gs.map(function (g) { return SRC_LABEL[g.source] + " median " + fmtMin(g.last7.p50); }).join(", "),
        items: gs.map(function (g) { return { cat: cat(g.source), p50: g.last7.p50, p95: g.last7.p95 }; })
      };
    });
    if (!rows.length) { $("delay-chart").innerHTML = '<p class="empty-chart">No publication has been measured yet.</p>'; return; }
    dotRange($("delay-chart"), rows, { axis: "minutes after the interval ends" });
    var slow = imb.filter(function (g) { return g.last7.max != null && g.last7.p95 != null && g.last7.max > 3 * g.last7.p95; })
      .sort(function (a, b) { return b.last7.max - a.last7.max; })[0];
    /* When several sources saw their slowest price for the same interval, it is not one series' outlier. */
    var shared = slow && sharedSlowest(imb);
    var together = shared && shared.groups.indexOf(slow) >= 0 ? shared : null;
    var lateImb = lateSummary(imb);
    $("delay-callout").innerHTML = (lateImb.n ? lateSentence(lateImb) + " " : "") + (together
      ? "Outlier: one 15-minute price, the one starting " + esc(together.at) + ", took <b>" + esc(together.span) +
        "</b> to appear at " + esc(joinList(together.names)) + " alike, against 95th percentiles of " + p95Range(together.groups) + "."
      : slow
      ? "Outlier: one " + esc(SRC_LABEL[slow.source]) + " " + esc(slow.zone) + " price took <b>" + fmtDur(slow.last7.max) +
        "</b>, against a 95th percentile of " + fmtMin(slow.last7.p95) + "."
      : "");
  }

  function p95Range(gs) {
    var v = gs.map(function (g) { return g.last7.p95; }).filter(function (x) { return x != null; });
    if (!v.length) return "—";
    var lo = Math.round(Math.min.apply(null, v)), hi = Math.round(Math.max.apply(null, v));
    return lo === hi ? lo + " min" : lo + "–" + hi + " min";
  }

  function renderShare(s) {
    /* With enough history the card follows prices watched for MATURE_DAYS or more; a price
       first seen this week may still change, so the 7-day share is only the fallback. */
    var mature = matureCohort(s);
    var basis = mature
      ? mature.series.map(function (x) {
        return { source: x.g.source, zone: x.g.zone, last7: { published: x.published, revised: x.revised, revised_share: x.revised / x.published, lag_p50_h: null } };
      })
      : imbalanceGroups(s);
    var sub = $("share-sub");
    if (sub) {
      sub.textContent = mature
        ? "Prices first seen " + mature.days + ", watched for " + MATURE_DAYS + " days or more, that were changed or withdrawn since. Newer prices are left out because they can still change."
        : "Prices first seen in the " + state.cov.label + " that were changed or withdrawn since. They have had less than " + MATURE_DAYS + " days to change, so this share can still rise.";
    }
    var imb = basis.filter(function (g) { return g.last7.published >= 10; });
    var hit = imb.filter(function (g) { return g.last7.revised_share > 0; })
      .sort(function (a, b) { return b.last7.revised_share - a.last7.revised_share; });
    hbars($("share-chart"), hit.map(function (g) {
      var l = g.last7;
      return {
        label: SRC_LABEL[g.source] + " · " + g.zone, value: l.revised_share, color: catColor(cat(g.source)),
        text: fmtPct(l.revised_share) + "  (" + l.revised + "/" + l.published + ")",
        aria: SRC_LABEL[g.source] + " " + g.zone + ": " + fmtPct(l.revised_share) + " changed",
        tip: '<div class="t-title">' + esc(SRC_LABEL[g.source]) + " · " + esc(g.zone) + "</div>" +
          tipRow(cat(g.source), "Changed later", fmtPct(l.revised_share, 1)) +
          tipRow(cat(g.source), "Prices", l.revised + " of " + l.published) +
          (l.lag_p50_h != null ? tipRow(cat(g.source), "Typically after", fmtHours(l.lag_p50_h)) : "")
      };
    }), {
      tick: function (t) { return Math.round(t * 100) + "%"; },
      step: function (m) { return m > 0.5 ? 0.25 : m > 0.2 ? 0.1 : 0.05; },
      empty: mature ? "None of the prices first seen " + mature.days + " has been changed since."
        : "No price first seen in the " + state.cov.label + " has been changed so far."
    });
    var zero = imb.filter(function (g) { return !g.last7.revised; });
    var bySrc = {};
    zero.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g.zone); });
    /* "No change so far" is about the window's own first prices. Changes to older prices are
       named with their delay, so the two statements cannot be read as a contradiction. */
    var late = lateRevisions(s, state.revisions);
    $("share-note").textContent = (Object.keys(bySrc).length
      ? (mature ? "No change to those prices at: " : "No change so far to the prices first seen in this window: ") +
        Object.keys(bySrc).map(function (k) { return SRC_LABEL[k] + " (" + zoneRange(bySrc[k]) + ")"; }).join("; ") + "."
      : "") + (late ? " Logged in the " + state.cov.label + ": " + (late.n === 1 ? "1 change to a price" : fmtInt(late.n) + " changes to prices") +
        " first seen before it, " + late.span + " after first publication." + (mature ? "" : " That is longer than this window follows a price.") : "");
  }

  function renderSize(revs) {
    var by = {};
    revs.forEach(function (r) {
      if (r.data !== "imbalance" || isCompletion(r)) return;
      var k = r.source + "|" + r.zone;
      var b = by[k] = by[k] || { n: 0, zero: 0, withdrawn: 0, sizes: [] };
      b.n++;
      if (r.kind === "withdrawn") b.withdrawn++;
      else if (r.old === 0) b.zero++;
      else b.sizes.push(Math.abs(r.new - r.old));
    });
    var rows = Object.keys(by).map(function (k) {
      var src = k.split("|")[0], zone = k.split("|")[1], b = by[k];
      var nonZero = b.n - b.zero - b.withdrawn;
      return {
        label: SRC_LABEL[src] + " · " + zone, value: b.n, color: catColor(cat(src)),
        text: b.n + (b.zero === b.n ? ", all from 0.00" : b.zero ? ", " + b.zero + " from 0.00" : ""),
        aria: SRC_LABEL[src] + " " + zone + ": " + b.n + " changes, " + b.zero + " replaced 0.00",
        tip: '<div class="t-title">' + esc(SRC_LABEL[src]) + " · " + esc(zone) + "</div>" +
          tipRow(cat(src), "Replaced a 0.00 price", fmtInt(b.zero)) +
          tipRow(cat(src), "Changed a non-zero price", fmtInt(nonZero)) +
          (b.withdrawn ? tipRow(cat(src), "Withdrawn", fmtInt(b.withdrawn)) : "") +
          (b.sizes.length ? '<div class="t-sub">Median change ' + fmtPrice(median(b.sizes)) + " EUR/MWh</div>" : "")
      };
    }).sort(function (a, b) { return b.value - a.value; });
    hbars($("size-chart"), rows, {
      tick: function (t) { return fmtInt(t); },
      /* Counts are whole numbers, so the axis steps by at least 1 (no "0 0 1 1 1"). */
      step: function (m) { return Math.max(1, niceStep(m, 4)); },
      empty: "No imbalance price change in the log yet."
    });
  }

  function renderHistogram(s, revs) {
    var el = $("hist-chart");
    var real = revs.filter(function (r) { return !isCompletion(r); });
    var done = dedupeJoint(revs).filter(isCompletion);
    if (!real.length && !done.length) { el.innerHTML = '<p class="empty-chart">No revision has been recorded in the ' + esc(state.cov.label) + '.</p>'; return; }
    var HOUR = 3600000;
    var first = Math.floor(Math.min.apply(null, revs.map(function (r) { return Date.parse(r.revised_at); })) / HOUR) * HOUR;
    var last = Math.floor(Date.parse(s.generated_at) / HOUR) * HOUR;
    var buckets = [], index = {};
    for (var t = first; t <= last; t += HOUR) {
      var iso = new Date(t).toISOString();
      var hour = +fmtTime(iso, { hour: "2-digit", hourCycle: "h23" });
      index[t] = buckets.length;
      buckets.push({
        counts: {}, title: dateTime(iso) + " " + tzName(iso), hour: hour,
        dayLabel: hour === 0 ? fmtTime(iso, { day: "numeric", month: "short" }) : "",
        hourLabel: fmtTime(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      });
    }
    real.forEach(function (r) {
      var b = buckets[index[Math.floor(Date.parse(r.revised_at) / HOUR) * HOUR]];
      if (b) b.counts[cat(r.source)] = (b.counts[cat(r.source)] || 0) + 1;
    });
    done.forEach(function (r) {
      var b = buckets[index[Math.floor(Date.parse(r.revised_at) / HOUR) * HOUR]];
      if (b) b.counts.completed = (b.counts.completed || 0) + 1;
    });
    var strips = CAT_ORDER.filter(function (c) { return real.some(function (r) { return cat(r.source) === c; }); });
    if (done.length) strips.push("completed");
    $("hist-legend").innerHTML = "";
    /* One strip per source with its own scale: a single large reserve batch must not
       flatten the hourly imbalance pattern. Completions get their own strip, counted
       once per joint market, and are not revisions. */
    el.innerHTML = strips.map(function (c, i) {
      var top = Math.max.apply(null, buckets.map(function (b) { return b.counts[c] || 0; }));
      return '<div class="strip"><div class="strip-label"><span class="src">' + swatch(c) + esc(CAT_LABEL[c]) +
        '</span><span class="muted">most in an hour: ' + fmtInt(top) + '</span></div><div class="strip-plot" data-strip="' + i + '"></div></div>';
    }).join("");
    /* Fewer sources get taller strips, so a single source is not squeezed into a thin band. */
    var height = strips.length === 1 ? 140 : strips.length === 2 ? 100 : 76;
    strips.forEach(function (c, i) {
      stackedColumns(el.querySelector('[data-strip="' + i + '"]'), buckets, [c], { height: height, axis: i === strips.length - 1, hourTicks: true });
    });
  }

  function renderZonesTable(s) {
    var rows = imbalanceGroups(s);
    /* Speed against the fastest source in the same zone: first, within 15 minutes, or slower. */
    state.fastest = fastestByZone(rows);  /* read at render time: the table keeps these closures */
    var speed = function (g) {
      var f = state.fastest[g.zone];
      if (g.last7.p50 == null || !f) return "";
      var gap = g.last7.p50 - f.last7.p50;
      var k = gap <= 0 ? ["up", "First in " + g.zone] : gap <= 15 ? ["amber", Math.round(gap) + " min behind the first"]
        : ["down", Math.round(gap) + " min behind the first"];
      return '<span class="dot ' + k[0] + '" title="' + esc(k[1]) + '" aria-label="' + esc(k[1]) + '"></span>';
    };
    var shareTone = function (v) { return v == null ? "" : v === 0 ? "up" : v < 0.1 ? "amber" : "down"; };
    if (state.tables.zones) { state.tables.zones.setRows(rows); return; }
    state.tables.zones = new DataTable($("zones-table"), {
      id: "zones", rows: rows, page: 100, csvName: "nordic-imbalance-publication.csv",
      sort: { key: "zone", dir: "asc" }, filters: ["country", "source"],
      columns: [
        { key: "zone", label: "Zone", get: function (g) { return g.zone; }, html: function (g) { return "<b>" + esc(g.zone) + "</b>"; },
          filterSort: function (a, b) { return zoneIndex(a) - zoneIndex(b); } },
        { key: "country", label: "Country", plural: "countries", get: function (g) { return country(g.zone); } },
        { key: "source", label: "Source", get: function (g) { return SRC_LABEL[g.source]; }, html: function (g) { return srcCell(g.source); } },
        { key: "p50", label: "Median delay", csvLabel: "Median delay (min)", num: true, get: function (g) { return g.last7.p50; }, html: function (g) { return '<span class="speed">' + speed(g) + fmtMin(g.last7.p50) + "</span>"; } },
        { key: "p95", label: "95% within", csvLabel: "95% within (min)", num: true, get: function (g) { return g.last7.p95; }, html: function (g) { return fmtMin(g.last7.p95); } },
        { key: "max", label: "Slowest timed", csvLabel: "Slowest timed (min)", num: true, get: function (g) { return g.last7.max; }, html: function (g) { return fmtDur(g.last7.max); } },
        { key: "n", label: "Intervals", num: true, get: function (g) { return g.last7.n; }, html: function (g) { return fmtInt(g.last7.n); } },
        { key: "share", label: "Changed so far", csvLabel: "Changed so far (share)", num: true, get: function (g) { return g.last7.revised_share; },
          html: function (g) {
            var v = g.last7.revised_share;
            return v == null ? "—" : '<span class="meter ' + shareTone(v) + '">' + fmtPct(v, 1) + '<span class="b"><i style="width:' + Math.max(v > 0 ? 4 : 0, Math.round(v * 100)) + '%"></i></span></span>';
          } },
        { key: "revisions", label: "Changes seen", num: true, get: function (g) { return g.last7.revisions; }, html: function (g) { return fmtInt(g.last7.revisions); } },
        { key: "lag", label: "Typically after", csvLabel: "Typically changed after (h)", num: true, get: function (g) { return g.last7.lag_p50_h; }, html: function (g) { return fmtHours(g.last7.lag_p50_h); } }
      ]
    });
  }

  /* A capacity price changed later than it typically comes out ahead of delivery was changed
     after delivery, so no later auction explains it. The source gives no reason, and a value
     first shown as zero and filled in later looks the same as a corrected one, so the page
     states the timing and nothing about the cause. */
  function changedAfterDelivery(g) {
    /* When the collector decides it per change, every revision of the series was after delivery. */
    if (g.last7.revisions_after_delivery != null) {
      return g.last7.revisions > 0 && g.last7.revisions_after_delivery === g.last7.revisions;
    }
    /* Older data files: the series' typical revision lag against its typical lead. */
    var lag = g.last7.lag_p50_h, lead = g.last7.p50 != null && g.last7.p50 < 0 ? -g.last7.p50 / 60 : null;
    return lag != null && lead != null && lag > lead;
  }
  /* Revisions after delivery across groups, in the reserve unit; null when not counted per change. */
  function afterDeliveryCount(gs) {
    if (!gs.length || gs.some(function (g) { return g.last7.revisions_after_delivery == null; })) return null;
    return ru().of(sum(gs.map(function (g) { return g.last7.revisions_after_delivery; })));
  }

  /* A capacity price is not always seen ahead of delivery. Where the 95th percentile of a
     series is after the end of the delivery quarter-hour, at least 1 in 20 of its prices was
     first seen only after delivery, and the callout says so, per source. */
  function seenAfterDelivery(res) {
    var bySrc = {};
    /* When the collector counts them, the exact share first seen after delivery had started. */
    var exact = res.some(function (g) { return g.last7.seen_after_start != null; });
    res.forEach(function (g) {
      var hit = exact ? g.last7.seen_after_start > 0 : g.last7.p95 != null && g.last7.p95 > 0;
      if (g.last7.n > 0 && hit) (bySrc[g.source] = bySrc[g.source] || []).push(g);
    });
    return Object.keys(bySrc).map(function (src) {
      var gs = bySrc[src];
      var products = uniq(gs.map(function (g) { return g.data.split(" ")[0]; })).sort();
      if (exact) {
        var seen = ru().of(sum(gs.map(function (g) { return g.last7.seen_after_start; }))), all = ru().of(sum(gs.map(function (g) { return g.last7.n; })));
        return esc(SRC_LABEL[src]) + " " + esc(joinList(products)) + " (" + esc(zoneRange(uniq(gs.map(function (g) { return g.zone; })))) +
          "): not always ahead of delivery. <b>" + fmtInt(seen) + " of " + fmtInt(all) + "</b> " + ru().delivery + " (" + fmtPct(seen / all) +
          ") were first seen after delivery had started.";
      }
      var worst = Math.max.apply(null, gs.map(function (g) { return g.last7.max != null ? g.last7.max : g.last7.p95; }));
      return esc(SRC_LABEL[src]) + " " + esc(joinList(products)) + " (" + esc(zoneRange(uniq(gs.map(function (g) { return g.zone; })))) +
        "): not always ahead of delivery. At least <b>1 in 20</b> " + ru().delivery + " was first seen after it had ended, up to " +
        fmtHours(worst / 60) + " after.";
    });
  }

  /* Capacity prices first seen more than 48 hours after delivery: counted by the collector,
     left out of the lead times, and named here per source. */
  function lateAfterDelivery(res) {
    var bySrc = {};
    res.forEach(function (g) { if (g.last7.late > 0) (bySrc[g.source] = bySrc[g.source] || []).push(g); });
    return Object.keys(bySrc).sort().map(function (src) {
      var gs = bySrc[src], n = ru().of(sum(gs.map(function (g) { return g.last7.late; })));
      var products = uniq(gs.map(function (g) { return g.data.split(" ")[0]; })).sort();
      var worst = Math.max.apply(null, gs.map(function (g) { return g.last7.late_max_h || 0; }));
      return esc(SRC_LABEL[src]) + " " + esc(joinList(products)) + " (" + esc(zoneRange(uniq(gs.map(function (g) { return g.zone; })))) +
        "): <b>" + fmtInt(n) + "</b> " + (n === 1 ? ru().deliveryOne + " was" : ru().delivery + " were") + " first priced more than 48 hours after " +
        (n === 1 ? "it" : "they") + " ended" + (worst ? ", up to " + fmtHours(worst) + " after" : "") + ". " +
        (n === 1 ? "It is" : "They are") + " counted, not timed.";
    });
  }

  function renderLead(s) {
    var res = reserveGroups(s);
    var measured = res.filter(function (g) { return g.last7.n > 0 && startDelay(g, "p50") != null && startDelay(g, "p50") < 0; });
    var leadSub = $("lead-sub");
    if (leadSub) {
      leadSub.textContent = "Median over the " + ru().delivery + " of the " + state.cov.label + ", measured to " +
        (leadFromStart(res) ? "the start of delivery" : "the end of each quarter-hour") +
        ". A delivery day is usually published in one batch, so its first hours have the shortest lead.";
    }
    var agg = {};
    measured.forEach(function (g) {
      var k = g.source + "|" + g.data;
      (agg[k] = agg[k] || { source: g.source, data: g.data, groups: [] }).groups.push(g);
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k], hours = -median(a.groups.map(function (g) { return startDelay(g, "p50"); })) / 60;
      var zones = zoneRange(a.groups.map(function (g) { return g.zone; }));
      return {
        label: SRC_LABEL[a.source] + " · " + a.data, value: hours, color: catColor(cat(a.source)),
        text: fmtHours(hours) + " · " + zones,
        short: fmtHours(hours) + " · " + a.groups.length + (a.groups.length === 1 ? " zone" : " zones"),
        aria: SRC_LABEL[a.source] + " " + a.data + ": " + fmtHours(hours) + " ahead, " + zones,
        tip: '<div class="t-title">' + esc(SRC_LABEL[a.source]) + " · " + esc(a.data) + "</div>" +
          tipRow(cat(a.source), "Median lead", fmtHours(hours)) +
          tipRow(cat(a.source), "Zones", esc(zones)) +
          tipRow(cat(a.source), ru().delivery.charAt(0).toUpperCase() + ru().delivery.slice(1) + " per zone", fmtInt(ru().of(sum(a.groups.map(function (g) { return g.last7.n; }))) / a.groups.length))
      };
    }).sort(function (a, b) { return b.value - a.value; });
    hbars($("lead-chart"), rows, {
      tick: function (t) { return t + " h"; },
      step: function (m) { return m > 30 ? 12 : m > 12 ? 6 : 3; },
      empty: "No first publication of a capacity price has been measured yet."
    });
    var revised = res.filter(function (g) { return rePriced(g) > 0; });
    var bySrc = {};
    revised.forEach(function (g) { (bySrc[g.source + "|" + g.data.split(" ")[0]] = bySrc[g.source + "|" + g.data.split(" ")[0]] || []).push(g); });
    $("lead-callout").innerHTML = Object.keys(bySrc).map(function (k) {
      var gs = bySrc[k], lag = lagOf(gs, "lag_p50_h");
      var n = fmtInt(ru().of(sum(gs.map(rePriced)))), per = perZoneCompletions(gs), rev = ru().of(zoneSum(gs));
      var head = esc(SRC_LABEL[gs[0].source]) + " " + esc(k.split("|")[1]) + " (" + esc(zoneRange(gs.map(function (g) { return g.zone; }))) + "): ";
      var after = lag != null ? ", typically " + fmtHours(lag) + " after first publication" : "";
      var late = afterDeliveryCount(gs);
      /* Counted per change: some revisions after delivery, some before. Both are said. */
      if (late != null && rev && late > 0 && late < rev) {
        return head + "<b>" + fmtInt(rev) + " " + ru().zone + "</b> revised" + after + ", <b>" + fmtInt(late) +
          "</b> of them after delivery. A later auction does not explain a change after delivery, and the source gives no reason." +
          (per ? " A later auction also completed " + per + "." : "");
      }
      if (gs.every(changedAfterDelivery)) {
        return head + (rev ? "<b>" + fmtInt(rev) + " " + ru().zone + "</b> changed" + after +
          ". That is after delivery, so a later auction does not explain it; the source gives no reason for the change." : "") +
          (per ? (rev ? " A later auction also completed " : "A later auction completed ") + per + "." : "");
      }
      if (per) {
        var clag = lagOf(gs, "completion_lag_p50_h");
        return head + "completed by a later auction " + per +
          (clag != null ? ", typically " + fmtHours(clag) + " after first publication" : "") +
          (rev ? "; " + fmtInt(rev) + " " + ru().zone + " revised" : "") + ".";
      }
      return head + "re-priced in <b>" + n + " " + ru().zone + "</b>" + after + ".";
    }).concat(seenAfterDelivery(res)).concat(lateAfterDelivery(res)).join("<br>");
    /* A product is "not measured yet" only when none of its zones and directions has a
       price in the window; one zone without procurement does not make the product unmeasured. */
    var pending = {};
    res.forEach(function (g) {
      var k = SRC_LABEL[g.source] + " " + g.data.split(" ")[0];
      var seen = g.last7.n > 0 || rePriced(g) > 0;
      pending[k] = (k in pending ? pending[k] : true) && !seen;
    });
    var names = Object.keys(pending).filter(function (k) { return pending[k]; }).sort();
    $("lead-pending").textContent = names.length ? "Not measured yet in the " + state.cov.label + ": " + names.join(", ") + "." : "";
  }

  function renderReserveTable(s) {
    var rows = reserveGroups(s).filter(function (g) { return g.last7.n > 0 || rePriced(g) > 0; });
    var ahead = function (m) { return m == null ? null : -m / 60; };
    var done = rows.some(function (g) { return g.last7.completions != null; });
    var timed = done && rows.some(function (g) { return "completion_lag_p50_h" in g.last7; });
    var fromStart = leadFromStart(rows);
    /* Data files from before the completions field keep the old column and its note. */
    $("restab-note").innerHTML = (done
      ? "&ldquo;Revised&rdquo; counts every change recorded in the <span data-window>" + esc(state.cov.label) + "</span>, " +
        "including changes to delivery " + ru().many + " from before it; &ldquo;Completed later&rdquo; counts the " + ru().many + " whose price a later auction completed, which are not revisions." + (ru().div === 4 ? " Counts are in hours, the unit the sources publish reserve prices in." : "")
      : "&ldquo;Price changes&rdquo; counts every change recorded in the <span data-window>" + esc(state.cov.label) + "</span>, " +
        "including changes to delivery " + ru().many + " from before it.") +
      (timed ? " &ldquo;Revised after&rdquo; and &ldquo;Completed after&rdquo; are median hours from first publication." : "");
    var leadNote = $("restab-lead");
    if (leadNote) {
      leadNote.textContent = "“Median lead” and “95% at least” are hours before " +
        (fromStart ? "delivery starts" : "each delivery quarter-hour ends") + "; a negative value means the price was first seen after that.";
    }
    if (state.tables.reserves) { state.tables.reserves.setRows(rows); return; }
    state.tables.reserves = new DataTable($("reserve-table"), {
      id: "reserves", rows: rows, page: 100, csvName: "nordic-reserve-publication.csv",
      sort: { key: "source", dir: "asc" }, filters: ["source", "product", "zone"],
      empty: "No capacity price has been measured yet.",
      columns: [
        { key: "source", label: "Source", get: function (g) { return SRC_LABEL[g.source]; }, html: function (g) { return srcCell(g.source); } },
        { key: "product", label: "Product", get: function (g) { return g.data; } },
        { key: "zone", label: "Zone", get: function (g) { return g.zone; }, filterSort: function (a, b) { return zoneIndex(a) - zoneIndex(b); } },
        { key: "lead", label: "Median lead", csvLabel: "Median lead (h before " + (fromStart ? "delivery starts" : "the quarter-hour ends") + ")", num: true, get: function (g) { return ahead(startDelay(g, "p50")); }, html: function (g) { return fmtHours(ahead(startDelay(g, "p50"))); } },
        { key: "lead95", label: "95% at least", csvLabel: "95% at least (h before " + (fromStart ? "delivery starts" : "the quarter-hour ends") + ")", num: true, get: function (g) { return ahead(startDelay(g, "p95")); }, html: function (g) { return fmtHours(ahead(startDelay(g, "p95"))); } },
        { key: "n", label: ru().div === 4 ? "Hours" : "Quarter-hours", num: true, get: function (g) { return ru().of(g.last7.n); }, html: function (g) { return fmtInt(ru().of(g.last7.n)); } },
        { key: "revisions", label: done ? "Revised" : "Price changes", num: true, get: function (g) { return ru().of(g.last7.revisions); }, html: function (g) { return fmtInt(ru().of(g.last7.revisions)); } },
        done ? { key: "completions", label: "Completed later", num: true, get: function (g) { return ru().of(g.last7.completions); },
          html: function (g) { return g.last7.completions == null ? "—" : fmtInt(ru().of(g.last7.completions)); } } : null,
        { key: "lag", label: timed ? "Revised after" : "Typically after", csvLabel: timed ? "Revised after (h)" : "Typically after (h)", num: true, get: function (g) { return g.last7.lag_p50_h; }, html: function (g) { return fmtHours(g.last7.lag_p50_h); } },
        timed ? { key: "doneLag", label: "Completed after", csvLabel: "Completed after (h)", num: true, get: function (g) { return g.last7.completion_lag_p50_h; }, html: function (g) { return fmtHours(g.last7.completion_lag_p50_h); } } : null
      ].filter(Boolean)
    });
  }

  /* The log lists revisions; prices a later auction completed join only when asked for,
     and then the Type column shows itself so they are not mistaken for revisions. */
  function doneToggle(t, revs) {
    var done = revs.filter(isCompletion), label = t.doneLabel;
    if (!done.length) {
      if (label) {
        label.remove(); t.doneLabel = null;
        if (t.doneShown && t.hidden.indexOf("kind") < 0) t.hidden.push("kind");
        t.doneShown = false;
      }
      return;
    }
    if (!label) {
      label = t.doneLabel = document.createElement("label");
      label.className = "rev-done";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", function () {
        t.doneShown = box.checked;
        var i = t.hidden.indexOf("kind");
        if (box.checked) { if (i >= 0) t.hidden.splice(i, 1); } else if (i < 0) t.hidden.push("kind");
        t.setRows(box.checked ? t.allRows : t.realRows);
      });
      label.appendChild(box);
      label.appendChild(document.createElement("span"));
      t.el.insertBefore(label, t.el.firstChild);
    }
    var m = done.length;
    var entries = dedupeJoint(done).length;
    label.lastChild.textContent = "Also list completions by a later auction (" +
      fmtInt(entries) + " log " + (entries === 1 ? "entry" : "entries") + ", shown as " + fmtInt(m) + " zone row" + (m === 1 ? "" : "s") + ")";
  }

  function renderRevisionTable(revs) {
    var change = function (r) { return r.new == null ? null : r.new - r.old; };
    var after = function (r) { return (Date.parse(r.revised_at) - Date.parse(r.first_published_at)) / 3600000; };
    var real = revs.filter(function (r) { return !isCompletion(r); });
    var t = state.tables.revisions;
    if (t) {
      t.allRows = revs; t.realRows = real;
      doneToggle(t, revs);
      t.setRows(t.doneShown ? revs : real);
      return;
    }
    t = state.tables.revisions = new DataTable($("rev-table"), {
      id: "revisions", rows: real, page: 50, csvName: "nordic-balancing-revisions.csv",
      sort: { key: "revised_at", dir: "desc" }, filters: ["source", "data", "zone", "kind"],
      search: "Search zone, source, product…",
      empty: real.length ? "No revision matches these filters." : "No revision has been recorded in the " + state.cov.label + ".",
      columns: [
        { key: "revised_at", label: "Revised at", time: true, get: function (r) { return r.revised_at; },
          text: function (r) { return dateTime(r.revised_at); },
          html: function (r) { return esc(dateTime(r.revised_at)) + ' <span class="muted">' + esc(tzName(r.revised_at)) + "</span>"; } },
        { key: "source", label: "Source", get: function (r) { return SRC_LABEL[r.source]; }, html: function (r) { return srcCell(r.source); } },
        { key: "data", label: "Series", plural: "series", get: function (r) { return r.data; } },
        { key: "zone", label: "Zone", get: function (r) { return r.zone; }, filterSort: function (a, b) { return zoneIndex(a) - zoneIndex(b); } },
        { key: "interval", label: "Delivery interval", time: true, get: function (r) { return r.interval_start; },
          text: function (r) { return dateTime(r.interval_start); },
          html: function (r) { return esc(dateTime(r.interval_start)) + ' <span class="muted">· ' + esc(r.interval_minutes) + " min</span>"; } },
        { key: "old", label: "Price before", num: true, get: function (r) { return r.old; }, html: function (r) { return fmtPrice(r.old); } },
        { key: "new", label: "Price after", num: true, get: function (r) { return r.new; },
          html: function (r) { return r.new == null ? '<span class="tag withdrawn">Withdrawn</span>' : "<b>" + fmtPrice(r.new) + "</b>"; } },
        { key: "unit", label: "Unit", get: function (r) { return r.unit; }, html: function (r) { return '<span class="muted">' + esc(r.unit) + "</span>"; } },
        { key: "change", label: "Change", num: true, get: change,
          html: function (r) {
            return r.new == null ? "—" : chg(r.old, r.new, { plain: true });
          } },
        { key: "after", label: "After", csvLabel: "After first publication (h)", num: true, get: after, html: function (r) { return fmtHours(after(r)); } },
        { key: "kind", label: "Type", get: function (r) { return KIND_LABEL[r.kind] || "Changed"; },
          html: function (r) { return '<span class="tag ' + esc(r.kind) + '">' + esc(KIND_LABEL[r.kind] || "Changed") + "</span>"; }, hidden: true },
        { key: "first", label: "First published", time: true, hidden: true, get: function (r) { return r.first_published_at; },
          html: function (r) { return esc(dateTime(r.first_published_at)); } }
      ]
    });
    t.allRows = revs; t.realRows = real;
    doneToggle(t, revs);
  }

  function renderTrend(s) {
    var imb = (s.groups || []).filter(function (g) { return g.data === "imbalance"; });
    var days = uniq([].concat.apply([], imb.map(function (g) { return (g.daily || []).map(function (d) { return d.day; }); }))).sort();
    if (days.length < 3) { $("trend").hidden = true; return; }
    $("trend").hidden = false;
    var cats = CAT_ORDER.filter(function (c) { return imb.some(function (g) { return cat(g.source) === c; }); });
    legend($("trend-legend"), cats);
    var series = cats.map(function (c) {
      return {
        cat: c,
        values: days.map(function (d) {
          var vals = [];
          imb.forEach(function (g) {
            if (cat(g.source) !== c) return;
            (g.daily || []).forEach(function (e) { if (e.day === d && e.p50 != null) vals.push(e.p50); });
          });
          return median(vals);
        })
      };
    });
    lines($("trend-chart"), days, series, { axis: "median minutes after the interval (across zones)" });
  }

  /* ---------- waitlist, footer, time zone ---------- */

  function renderWaitlist() {
    if (CFG.waitlist === false) { $("waitlist-section").hidden = true; return; }
    if (CFG.contactEmail) {
      $("wl-contact").innerHTML = ', or by writing to <a href="mailto:' + esc(CFG.contactEmail) + '">' + esc(CFG.contactEmail) + "</a>";
    }
    bindWaitlistRemoval();
    $("waitlist-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("wl-msg"), email = $("wl-email").value.trim();
      msg.className = "";
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = "Please enter a valid email address."; msg.className = "err"; return;
      }
      msg.textContent = "Sending…";
      fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email, role: $("wl-role").value, website: $("wl-website").value })
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (j) {
          if (res.ok && j.ok) {
            msg.textContent = "Thanks, you are on the list."; msg.className = "ok"; e.target.reset();
            if (typeof j.removeToken === "string" && REMOVE_TOKEN.test(j.removeToken)) {
              var link = location.origin + location.pathname + "#remove=" + j.removeToken;
              $("wl-link-a").href = link; $("wl-link-a").textContent = link;
              $("wl-link").hidden = false;
            }
          }
          else { msg.textContent = "Could not save that address" + (j && j.error ? ": " + j.error : "."); msg.className = "err"; }
        });
      }).catch(function () {
        msg.textContent = "Could not reach the server. Please try again later."; msg.className = "err";
      });
    });
  }

  /* A removal link is /#remove=<token>. The token stays in the fragment, so it is never sent in a
     request URL or Referer; it is read once, cleared from the address bar and sent only in the
     body of the removal request. Nothing is removed until the button is pressed. */
  var REMOVE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

  function bindWaitlistRemoval() {
    var m = /^#remove=(.*)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    var token = m[1], panel = $("wl-remove"), msg = $("wl-remove-msg"), btn = $("wl-remove-btn");
    panel.hidden = false;
    panel.scrollIntoView({ block: "center" });
    if (!REMOVE_TOKEN.test(token)) {
      msg.textContent = "This removal link is incomplete. Copy the whole link and try again.";
      msg.className = "err"; btn.disabled = true; return;
    }
    btn.addEventListener("click", function () {
      btn.disabled = true; msg.className = ""; msg.textContent = "Removing…";
      fetch("/api/waitlist", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token })
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (j) {
          if (res.ok && j.ok && j.removed) {
            msg.textContent = "Your address has been removed from the waitlist."; msg.className = "ok";
          } else if (res.ok && j.ok) {
            msg.textContent = "This link does not match an address on the list. It may have been used already.";
            msg.className = "err";
          } else {
            msg.textContent = "Could not remove the address" + (j && j.error ? ": " + j.error : ".");
            msg.className = "err"; btn.disabled = false;
          }
        });
      }).catch(function () {
        msg.textContent = "Could not reach the server. Please try again later."; msg.className = "err";
        btn.disabled = false;
      });
    });
  }

  function renderFooter() {
    if (CFG.collectorUrl) {
      $("collector-link").innerHTML = ' · <a href="' + esc(CFG.collectorUrl) + '" rel="noopener">data collector</a>';
    }
  }

  function bindTimeZone() {
    document.querySelectorAll(".tz button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-tz") === state.tz));
      b.addEventListener("click", function () {
        state.tz = b.getAttribute("data-tz");
        save("nbw.tz", state.tz);
        document.querySelectorAll(".tz button").forEach(function (o) {
          o.setAttribute("aria-pressed", String(o === b));
        });
        fitTopbar();
        if (state.summary) renderAll();
      });
    });
  }

  /* The section links sit beside the name when everything fits on one row and move to a strip
     underneath when it does not; the name gives way to its mark only when even that row is too
     tight, and then the zone button to its short label ("DK, NO"). Measured rather than set by
     width, because the zone label, the chosen time zone and the reader's fonts all change how
     much room there is. */
  function fitTopbar() {
    var bar = document.querySelector(".topbar"), wrap = bar.querySelector(".wrap"), name = bar.querySelector(".brand span"), nav = bar.querySelector(".nav");
    var zl = $("zp-label");
    if (zl.hasAttribute("data-long")) zl.textContent = zl.getAttribute("data-long");
    /* Fits: the name is whole, nothing spills past the bar, and the name and the controls share one line. */
    var fits = function () {
      var mid = [].filter.call(wrap.children, function (c) { return c !== nav && c.offsetWidth; })
        .map(function (c) { var r = c.getBoundingClientRect(); return r.top + r.height / 2; });
      return name.scrollWidth <= name.clientWidth + 0.5 && wrap.scrollWidth <= wrap.clientWidth + 0.5 &&
        Math.max.apply(null, mid) - Math.min.apply(null, mid) < 4;
    };
    bar.classList.add("fitted");
    bar.classList.remove("two-row", "short-name");
    if (!fits()) bar.classList.add("two-row");
    if (!fits()) bar.classList.add("short-name");
    if (!fits() && zl.hasAttribute("data-short")) zl.textContent = zl.getAttribute("data-short");
    document.documentElement.style.setProperty("--topbar-h", bar.offsetHeight + "px");
  }
  function bindTopbar() {
    var frame;
    fitTopbar();
    window.addEventListener("resize", function () {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitTopbar);
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTopbar);
  }

  /* Light or dark: follows the system until the reader picks one (set early by the inline
     script in the page head, so there is no flash). */
  function bindTheme() {
    var btn = $("theme-btn"), root = document.documentElement;
    var dark = function () {
      var t = root.getAttribute("data-theme");
      return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    function label() {
      var text = dark() ? "Switch to light mode" : "Switch to dark mode";
      btn.setAttribute("aria-label", text);
      btn.title = text;
    }
    btn.addEventListener("click", function () {
      var next = dark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      save("nbw.theme", next);
      label();
    });
    label();
  }

  /* The zone picker narrows every section to the zones a reader follows. */
  function bindZonePicker() {
    var btn = $("zp-btn"), pop = $("zp-pop");
    var countries = ["DK", "FI", "NO", "SE"];
    function label() {
      var n = state.zones ? state.zones.length : 0;
      var whole = countries.filter(function (c) {
        return ZONES.filter(function (z) { return z.slice(0, 2) === c; }).every(function (z) { return state.zones && state.zones.indexOf(z) >= 0; });
      });
      var covered = whole.length && whole.reduce(function (s, c) {
        return s + ZONES.filter(function (z) { return z.slice(0, 2) === c; }).length;
      }, 0) === n;
      $("zp-label").textContent = !state.zones ? "All zones" : covered && whole.length <= 2
        ? whole.map(function (c) { return COUNTRY[c]; }).join(", ")
        : n === 1 ? "Zone " + state.zones[0] : n + " zones";
      /* The shorter form the top bar falls back to on a narrow screen. */
      $("zp-label").setAttribute("data-short", !state.zones ? "All" : covered && whole.length <= 2
        ? whole.join(", ") : n === 1 ? state.zones[0] : n + " zones");
      $("zp-label").setAttribute("data-long", $("zp-label").textContent);
      btn.setAttribute("data-active", String(!!state.zones));
      fitTopbar();
    }
    function apply(list) {
      state.zones = list && list.length && list.length < ZONES.length ? list : null;
      save("nbw.zones", state.zones);
      label();
      if (state.summary) renderAll();
    }
    function draw() {
      var sel = state.zones || ZONES;
      pop.innerHTML = '<div class="pop-title">Show only these zones everywhere on the page</div>' + countries.map(function (c) {
        var zs = ZONES.filter(function (z) { return z.slice(0, 2) === c; });
        var on = zs.filter(function (z) { return sel.indexOf(z) >= 0; }).length;
        return '<fieldset><legend><input type="checkbox" data-country="' + c + '"' + (on === zs.length ? " checked" : "") +
          (on && on < zs.length ? ' data-mixed="1"' : "") + ' aria-label="All of ' + esc(COUNTRY[c]) + '">' + esc(COUNTRY[c]) + "</legend>" +
          (zs.length > 1 ? '<div class="zones">' + zs.map(function (z) {
            return '<label><input type="checkbox" data-zone="' + z + '"' + (sel.indexOf(z) >= 0 ? " checked" : "") + ">" + z + "</label>";
          }).join("") + "</div>" : "") + "</fieldset>";
      }).join("") + '<div class="pop-foot"><button type="button" class="btn ghost" data-all>Show all zones</button>' +
        '<button type="button" class="btn ghost" data-close>Done</button></div>';
      pop.querySelectorAll("[data-mixed]").forEach(function (cb) { cb.indeterminate = true; });
      pop.querySelectorAll("input[data-zone]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var cur = (state.zones || ZONES).slice(), z = cb.getAttribute("data-zone");
          if (cb.checked && cur.indexOf(z) < 0) cur.push(z);
          if (!cb.checked) cur = cur.filter(function (x) { return x !== z; });
          if (!cur.length) { cb.checked = true; return; }
          apply(ZONES.filter(function (x) { return cur.indexOf(x) >= 0; }));
          draw();
          var again = pop.querySelector('input[data-zone="' + z + '"]');
          if (again) again.focus();
        });
      });
      pop.querySelectorAll("input[data-country]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var c = cb.getAttribute("data-country"), cur = (state.zones || ZONES).slice();
          var zs = ZONES.filter(function (z) { return z.slice(0, 2) === c; });
          cur = cb.checked ? uniq(cur.concat(zs)) : cur.filter(function (z) { return zs.indexOf(z) < 0; });
          if (!cur.length) { cb.checked = true; return; }
          apply(ZONES.filter(function (x) { return cur.indexOf(x) >= 0; }));
          draw();
          var again = pop.querySelector('input[data-country="' + c + '"]');
          if (again) again.focus();
        });
      });
      pop.querySelector("[data-all]").addEventListener("click", function () { apply(null); draw(); });
      pop.querySelector("[data-close]").addEventListener("click", function () { close(); btn.focus(); });
    }
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }
    btn.addEventListener("click", function () {
      if (pop.hidden) { draw(); pop.hidden = false; btn.setAttribute("aria-expanded", "true"); } else close();
    });
    document.addEventListener("click", function (e) {
      if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !pop.hidden) { close(); btn.focus(); } });
    label();
  }

  function renderCitation(s) {
    var accessed = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
    var since = validTime(s.collecting_since) ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(s.collecting_since)) : "";
    var text = "Nordic Balancing Watch (" + new Date().getUTCFullYear() + "). Publication times and revisions of " +
      "Nordic imbalance and reserve capacity prices" + (since ? ", collected since " + since : "") + ". " +
      (CFG.siteUrl ? CFG.siteUrl.replace(/\/?$/, "/") + " (accessed " + accessed + ")." : "Accessed " + accessed + ".");
    $("cite-text").textContent = text;
    $("cite-copy").hidden = false;
    $("cite-copy").onclick = function () {
      var done = function () { $("cite-msg").textContent = "Copied."; };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { $("cite-msg").textContent = "Select the text to copy it."; });
      else $("cite-msg").textContent = "Select the text to copy it.";
    };
  }

  /* The summary and revisions narrowed to the selected zones. */
  function view() {
    var s = state.summary, out = {};
    for (var k in s) out[k] = s[k];
    out.groups = (s.groups || []).filter(function (g) { return inZones(g.zone); });
    out.now = (s.now || []).filter(function (e) { return inZones(e.zone); });
    return { s: out, revs: state.revisions.filter(function (r) { return inZones(r.zone); }) };
  }

  function renderCharts() {
    state.ru = reserveUnit(state.summary);
    state.leadStart = reserveGroups(state.summary || {}).some(function (g) { return g.last7 && g.last7.from_start_p50 != null; });
    var v = view();
    renderDelay(v.s);
    renderShare(v.s);
    renderLead(v.s);
    renderTrend(v.s);
    renderSize(v.revs);
    renderHistogram(v.s, v.revs);
  }

  function renderAll() {
    state.ru = reserveUnit(state.summary);
    state.leadStart = reserveGroups(state.summary || {}).some(function (g) { return g.last7 && g.last7.from_start_p50 != null; });
    var v = view();
    renderStatus(state.summary);
    renderCoverage(state.summary, v.s);
    renderStats(v.s);
    renderFindings(v.s, v.revs);
    renderHowTo(v.s);
    renderBoard(v.s);
    renderRecent(v.s, v.revs);
    renderCharts();
    renderZonesTable(v.s);
    renderReserveTable(v.s);
    renderRevisionTable(v.revs);
  }

  /* ---------- zone detail panel ---------- */

  /* One zone's last 7 days from every source, opened from the price board. The zone files
     put every source on one 15-minute grid starting at `start`. */
  var zd = { zone: null, n: 96, hidden: {}, data: {}, at: {} };
  var ZD_DASH = { esett: "", entsoe: "6 3", tso: "1.5 3.5" };
  var ZD_WIDTH = { esett: 1.6, entsoe: 2, tso: 3.2 };
  var ZD_STEP = 15 * 60000;

  function zdZones() {
    return uniq(((state.summary && state.summary.now) || []).map(function (e) { return e.zone; }))
      .filter(inZones).sort(function (a, b) { return zoneIndex(a) - zoneIndex(b); });
  }

  /* The file is trusted only as far as its shape: arrays of numbers or nulls, all on one grid. */
  function zdValid(d, zone) {
    if (!d || d.schema !== 1 || d.zone !== zone || d.interval_minutes !== 15 || !validTime(d.start)) return false;
    var n = null;
    var ok = function (a) {
      if (!Array.isArray(a) || (n != null && a.length !== n)) return false;
      n = a.length;
      return a.every(function (v) { return v === null || (typeof v === "number" && isFinite(v)); });
    };
    var series = d.series && typeof d.series === "object" ? d.series : null;
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    if (!series || !Object.keys(series).every(function (s) { return own(SRC_LABEL, s) && ok(series[s]); }) ||
      !["direction", "mfrr_up", "mfrr_down"].every(function (k) { return ok(d[k]); }) || !(n > 0) || !Array.isArray(d.revisions)) return false;
    /* Keep only well-formed revisions: [interval index, source, first price, first seen at]. */
    d.revisions = d.revisions.filter(function (r) {
      return Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 && r[0] < n && own(series, r[1]) &&
        typeof r[2] === "number" && isFinite(r[2]) && !!validTime(r[3]);
    });
    return true;
  }

  function zdOpen(zone) {
    if (ZONES.indexOf(zone) < 0) return;
    var dlg = $("zd");
    zd.zone = zone;
    if (!dlg.open) dlg.showModal();
    history.replaceState(null, "", "#zone=" + zone);
    $("zd-title").textContent = zone + " · " + country(zone);
    if (zd.data[zone] && Date.now() - zd.at[zone] < 5 * 60000) { zdRender(); return; }
    ["zd-sub", "zd-note", "zd-asof"].forEach(function (id) { $(id).textContent = ""; });
    $("zd-srcs").innerHTML = ""; $("zd-stats").innerHTML = "";
    $("zd-chart").innerHTML = '<p class="empty-chart">Loading ' + esc(zone) + "…</p>";
    fetchJson("/data/zone-" + zone + ".json").then(function (d) {
      if (!zdValid(d, zone)) throw new Error("unexpected zone data");
      zd.data[zone] = d;
      zd.at[zone] = Date.now();
      if (zd.zone === zone) zdRender();
    }).catch(function (err) {
      if (window.console) console.warn("zone data unavailable:", err.message || err);
      if (zd.zone === zone) $("zd-chart").innerHTML = '<p class="empty-chart">The detail data for ' + esc(zone) + " is not available right now.</p>";
    });
  }

  function zdStep(by) {
    var zones = zdZones(), i = zones.indexOf(zd.zone);
    if (zones.length) zdOpen(zones[(i + by + zones.length) % zones.length]);
  }

  function zdRender() {
    var d = zd.data[zd.zone];
    if (!d || !$("zd").open) return;
    var t0 = Date.parse(d.start);
    var iso = function (i) { return new Date(t0 + i * ZD_STEP).toISOString(); };
    var hm = function (i) { return fmtTime(iso(i), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); };
    /* With more than a day on screen a time needs its date. */
    var when = function (i) { return zd.n > 96 ? fmtTime(iso(i), { day: "numeric", month: "short" }) + " " + hm(i) : hm(i); };
    var srcs = Object.keys(d.series).sort(function (a, b) { return CAT_ORDER.indexOf(cat(a)) - CAT_ORDER.indexOf(cat(b)); });
    var last = -1;
    srcs.forEach(function (s) { for (var i = d.series[s].length - 1; i > last; i--) if (d.series[s][i] != null) { last = i; break; } });
    document.querySelectorAll("#zd-range button").forEach(function (b) { b.setAttribute("aria-pressed", String(+b.getAttribute("data-n") === zd.n)); });
    $("zd-asof").textContent = validTime(d.generated_at) ? "Data as of " + dateTime(d.generated_at) + " " + tzName(d.generated_at) : "";
    if (last < 0) {
      ["zd-sub", "zd-note"].forEach(function (id) { $(id).textContent = ""; });
      $("zd-srcs").innerHTML = ""; $("zd-stats").innerHTML = "";
      $("zd-chart").innerHTML = '<p class="empty-chart">No price for ' + esc(zd.zone) + " in the last 7 days.</p>";
      return;
    }
    var s0 = Math.max(0, last + 1 - zd.n);
    $("zd-sub").textContent = dateTime(iso(s0)) + " to " + dateTime(iso(last + 1)) + " " + tzName(iso(last)) +
      " · EUR/MWh, one value per 15 minutes";

    $("zd-srcs").innerHTML = srcs.map(function (s) {
      var c = cat(s);
      return '<label><input type="checkbox" data-src="' + esc(s) + '"' + (zd.hidden[s] ? "" : " checked") + ">" +
        '<svg width="24" height="10" aria-hidden="true"><line x1="1" x2="23" y1="5" y2="5" stroke="' + catColor(c) +
        '" stroke-width="2.4" stroke-dasharray="' + ZD_DASH[c] + '"/></svg>' + esc(SRC_LABEL[s] || s) + "</label>";
    }).join("") + '<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="var(--down)" stroke-width="2"/></svg>First price, later changed</span>';
    $("zd-srcs").querySelectorAll("input").forEach(function (box) {
      box.addEventListener("change", function () { zd.hidden[box.getAttribute("data-src")] = !box.checked; zdRender(); });
    });

    var revs = d.revisions.filter(function (r) { return r[0] >= s0 && r[0] <= last; });
    /* eSett's first figure for an interval can be a 0.00 placeholder while the others already
       have the price (Finland, about an hour). */
    var interim = [];
    if (d.series.esett) {
      for (var i = s0; i <= last; i++) {
        if (d.series.esett[i] !== 0) continue;
        var other = srcs.some(function (s) { return s !== "esett" && d.series[s][i] != null && Math.abs(d.series[s][i]) >= 1; });
        if (other) interim.push(i);
      }
    }
    var notes = [];
    if (interim.length) {
      notes.push('<span class="zd-warn">eSett shows 0.00 for ' + interim.length + (interim.length === 1 ? " interval" : " intervals") +
        " (" + esc(interim.slice(-4).map(when).join(", ")) + (interim.length > 4 ? ", …" : "") +
        ") while another source has the price. eSett&rsquo;s first figure can be a placeholder that is settled later.</span>");
    }
    if (revs.length) {
      var changed = uniq(revs.map(function (r) { return r[0]; })).length;
      notes.push('<span class="zd-rev">' + changed + (changed === 1 ? " interval" : " intervals") +
        " changed after first publication: the circles mark the first price; point at or tap an interval to see when it was first seen.</span>");
    }
    $("zd-note").innerHTML = notes.join(" ");

    zdChart(d, srcs, s0, last, revs, interim, iso, hm);
    zdStats(d, srcs, s0, last, revs, when);
  }

  function zdChart(d, srcs, s0, last, revs, interim, iso, hm) {
    var el = $("zd-chart");
    var W = Math.max(280, el.clientWidth), L = 48, R = 10, T = 10, PH = W < 500 ? 170 : 220, DH = 10;
    var DY = T + PH + 10, H = DY + DH + 26;
    var vis = srcs.filter(function (s) { return !zd.hidden[s]; });
    var vals = [];
    vis.forEach(function (s) { for (var i = s0; i <= last; i++) if (d.series[s][i] != null) vals.push(d.series[s][i]); });
    revs.forEach(function (r) { if (!zd.hidden[r[1]]) vals.push(r[2]); });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) { lo -= 1; hi += 1; }
    var step = niceStep(hi - lo, PH < 200 ? 3 : 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var N = last - s0 + 1, cw = (W - L - R) / N;
    var x = function (i) { return L + (i - s0 + 0.5) * cw; };
    var y = function (v) { return T + (hi - v) / (hi - lo) * PH; };
    var grid = "", ticks = "", body = "";
    for (var v = lo; v <= hi + step / 2; v += step) {
      var gy = y(v).toFixed(1);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"' + (Math.abs(v) < step / 2 && lo < 0 ? ' class="zero"' : "") + "/>";
      ticks += '<text x="' + (L - 6) + '" y="' + (+gy + 4) + '" text-anchor="end">' + esc(step >= 1 ? fmtInt(v) : v.toFixed(step >= 0.5 ? 1 : 2)) + "</text>";
    }
    /* Time labels as often as the width allows, on whole hours. */
    var every = [4, 8, 12, 24, 48, 96, 192].filter(function (k) { return k * cw >= 64; })[0] || 192;
    for (var i = s0; i <= last; i++) {
      if (Math.round((Date.parse(iso(i)) / ZD_STEP)) % every !== 0) continue;
      var label = hm(i) === "00:00" ? fmtTime(iso(i), { day: "numeric", month: "short" }) : hm(i);
      ticks += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(label) + "</text>";
    }
    /* Regulation direction from eSett: up, down or none, one cell per interval. */
    for (i = s0; i <= last; i++) {
      var dir = d.direction[i];
      if (dir == null) continue;
      var fill = dir > 0 ? "var(--up)" : dir < 0 ? "var(--down)" : "var(--axis)";
      body += '<rect x="' + (x(i) - cw / 2 + 0.25).toFixed(1) + '" y="' + DY + '" width="' + Math.max(0.6, cw - 0.5).toFixed(2) +
        '" height="' + DH + '" fill="' + fill + '" opacity="0.8"/>';
    }
    ticks += '<text x="' + (L - 6) + '" y="' + (DY + 9) + '" text-anchor="end">Dir.</text>';
    /* Thick dotted TSO line under the dashed ENTSO-E line under the thin eSett line, so
       sources that agree still show as one stacked line. */
    vis.slice().sort(function (a, b) { return CAT_ORDER.indexOf(cat(b)) - CAT_ORDER.indexOf(cat(a)); }).forEach(function (s) {
      var c = cat(s), p = "", pen = false;
      for (var j = s0; j <= last; j++) {
        var val = d.series[s][j];
        if (val == null) { pen = false; continue; }
        p += (pen ? "L" : "M") + x(j).toFixed(1) + " " + y(val).toFixed(1);
        pen = true;
      }
      if (p) body += '<path d="' + p + '" fill="none" stroke="' + catColor(c) + '" stroke-width="' + ZD_WIDTH[c] +
        '" stroke-dasharray="' + ZD_DASH[c] + '" stroke-linejoin="round" stroke-linecap="round"/>';
    });
    revs.forEach(function (r) {
      if (zd.hidden[r[1]] || d.series[r[1]][r[0]] == null) return;
      var rx = x(r[0]).toFixed(1);
      body += '<line x1="' + rx + '" x2="' + rx + '" y1="' + y(r[2]).toFixed(1) + '" y2="' + y(d.series[r[1]][r[0]]).toFixed(1) +
        '" stroke="var(--down)" stroke-dasharray="2 2"/><circle cx="' + rx + '" cy="' + y(r[2]).toFixed(1) +
        '" r="4.5" fill="var(--surface)" stroke="var(--down)" stroke-width="2"/>';
    });
    if (!zd.hidden.esett) interim.forEach(function (j) {
      body += '<circle cx="' + x(j).toFixed(1) + '" cy="' + y(0).toFixed(1) + '" r="4" fill="none" stroke="var(--amber)" stroke-width="2"/>';
    });
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '" role="img" aria-label="Imbalance price in ' + esc(zd.zone) +
      ' per 15 minutes by source, with the regulation direction below"><g class="grid">' + grid + '</g><g class="tick">' + ticks + "</g>" + body +
      '<line class="zd-x" x1="0" x2="0" y1="' + T + '" y2="' + (DY + DH) + '" visibility="hidden"/>' +
      '<rect class="zd-hit" x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + (DY + DH) + '" fill="transparent"/></svg>';

    var svg = el.querySelector("svg"), cross = el.querySelector(".zd-x"), hit = el.querySelector(".zd-hit");
    var at = function (e) {
      var b = svg.getBoundingClientRect();
      return Math.min(last, Math.max(s0, Math.floor(((e.clientX - b.left) / b.width * W - L) / cw) + s0));
    };
    var point = function (e) {
      var j = at(e);
      cross.setAttribute("x1", x(j)); cross.setAttribute("x2", x(j)); cross.setAttribute("visibility", "visible");
      showTip(zdTip(d, srcs, j, revs, iso, hm), e.clientX, e.clientY);
    };
    hit.addEventListener("pointermove", point);
    /* A tap has no pointer movement: it shows the interval and keeps it until the next tap. */
    hit.addEventListener("pointerup", function (e) { if (e.pointerType !== "mouse") point(e); });
    hit.addEventListener("pointerleave", function (e) {
      if (e.pointerType !== "mouse") return;
      cross.setAttribute("visibility", "hidden"); hideTip();
    });
  }

  function zdTip(d, srcs, i, revs, iso, hm) {
    var dir = d.direction[i];
    return '<div class="t-title">' + esc(fmtTime(iso(i), { day: "numeric", month: "short" }) + ", " + hm(i) + "–" + hm(i + 1) + " " + tzName(iso(i))) + "</div>" +
      srcs.map(function (s) {
        var r = revs.filter(function (q) { return q[0] === i && q[1] === s; })[0];
        return tipRow(cat(s), SRC_LABEL[s] || s, fmtPrice(d.series[s][i])) +
          (r ? '<div class="t-sub zd-was">First ' + fmtPrice(r[2]) + ", seen " + esc(dateTime(r[3])) + "</div>" : "");
      }).join("") +
      '<div class="t-sub">Direction: ' + (dir == null ? "not yet published" : dir > 0 ? "up" : dir < 0 ? "down" : "none") +
      (d.mfrr_up[i] != null || d.mfrr_down[i] != null ? "<br>mFRR up " + fmtPrice(d.mfrr_up[i]) + " · down " + fmtPrice(d.mfrr_down[i]) : "") + "</div>";
  }

  function zdStats(d, srcs, s0, last, revs, hm) {
    /* Figures come from the source with the most values in the window (ENTSO-E on ties). */
    var count = function (s) { var c = 0; for (var i = s0; i <= last; i++) if (d.series[s][i] != null) c++; return c; };
    var ref = srcs.slice().sort(function (a, b) { return count(b) - count(a) || (b === "entsoe") - (a === "entsoe"); })[0];
    var a = d.series[ref], vals = [], jump = 0, jumpAt = s0;
    for (var i = s0; i <= last; i++) {
      if (a[i] == null) continue;
      vals.push(a[i]);
      if (i > s0 && a[i - 1] != null && Math.abs(a[i] - a[i - 1]) > Math.abs(jump)) { jump = a[i] - a[i - 1]; jumpAt = i; }
    }
    var have = srcs.filter(function (s) { return d.series[s][last] != null; }), newest = have[0];
    var dirs = d.direction.slice(s0, last + 1).filter(function (x) { return x != null; });
    var up = dirs.filter(function (x) { return x > 0; }).length, down = dirs.filter(function (x) { return x < 0; }).length;
    var differ = 0, both = 0;
    for (i = s0; i <= last; i++) {
      var seen = srcs.filter(function (s) {
        var x = d.series[s][i];
        /* eSett's 0.00 placeholder is flagged on its own, not counted as a disagreement. */
        return x != null && !(s === "esett" && x === 0 && srcs.some(function (o) { return o !== s && d.series[o][i] != null && Math.abs(d.series[o][i]) >= 1; }));
      }).map(function (s) { return d.series[s][i]; });
      if (seen.length < 2) continue;
      both++;
      if (Math.max.apply(null, seen) - Math.min.apply(null, seen) > 0.005) differ++;
    }
    var tile = function (label, value, sub) {
      return '<div class="zd-stat"><span>' + esc(label) + "</span><b>" + value + "</b>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
    };
    $("zd-stats").innerHTML =
      tile("Latest", fmtPrice(d.series[newest][last]), esc(hm(last) + " · " + have.map(function (s) { return SRC_LABEL[s] || s; }).join(", "))) +
      tile("Low / high", fmtPrice(Math.min.apply(null, vals)) + " / " + fmtPrice(Math.max.apply(null, vals)), esc(SRC_LABEL[ref] || ref)) +
      tile("Average", fmtPrice(vals.length ? sum(vals) / vals.length : null), fmtInt(vals.length) + " intervals") +
      tile("Biggest 15-min move", (jump > 0 ? "+" : jump < 0 ? "−" : "") + fmtPrice(Math.abs(jump)), jump ? "into " + esc(hm(jumpAt)) : "") +
      tile("Regulated up / down", dirs.length ? fmtPct(up / dirs.length) + " / " + fmtPct(down / dirs.length) : "—", "eSett direction") +
      tile("Sources differ", both ? fmtInt(differ) + " of " + fmtInt(both) : "—", revs.length ? fmtInt(revs.length) + " later changes" : "intervals with 2+ sources");
  }

  function zdCsv() {
    var d = zd.data[zd.zone];
    if (!d) return;
    var srcs = Object.keys(d.series), t0 = Date.parse(d.start);
    var first = {};
    d.revisions.forEach(function (r) { if (Array.isArray(r) && d.series[r[1]]) first[r[0] + "|" + r[1]] = r[2]; });
    var revised = srcs.filter(function (s) { return d.revisions.some(function (r) { return r[1] === s; }); });
    var rows = [["Interval start (UTC)"].concat(srcs.map(function (s) { return (SRC_LABEL[s] || s) + " (EUR/MWh)"; }),
      revised.map(function (s) { return (SRC_LABEL[s] || s) + " first price before a change"; }),
      ["eSett direction", "eSett mFRR up (EUR/MWh)", "eSett mFRR down (EUR/MWh)"])];
    for (var i = 0; i < d.direction.length; i++) {
      var row = srcs.map(function (s) { return d.series[s][i]; });
      if (row.every(function (v) { return v == null; })) continue;
      rows.push([new Date(t0 + i * ZD_STEP).toISOString().replace(".000Z", "Z")].concat(row,
        revised.map(function (s) { return first[i + "|" + s]; }), [d.direction[i], d.mfrr_up[i], d.mfrr_down[i]]));
    }
    downloadCsv("nordic-imbalance-" + zd.zone + "-7-days.csv", rows);
  }

  function bindZonePanel() {
    var dlg = $("zd");
    $("board").addEventListener("click", function (e) {
      var row = e.target.closest && e.target.closest(".zd-row");
      if (row) zdOpen(row.getAttribute("data-zone"));
    });
    $("zd-range").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (b) { zd.n = +b.getAttribute("data-n"); zdRender(); }
    });
    $("zd-prev").addEventListener("click", function () { zdStep(-1); });
    $("zd-next").addEventListener("click", function () { zdStep(1); });
    $("zd-close").addEventListener("click", function () { dlg.close(); });
    $("zd-csv").addEventListener("click", zdCsv);
    /* Up and down switch zones while the panel fits the screen; when it has to scroll
       (a short screen), the keys scroll it as usual. */
    dlg.addEventListener("keydown", function (e) {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && dlg.scrollHeight <= dlg.clientHeight) {
        e.preventDefault();
        zdStep(e.key === "ArrowUp" ? -1 : 1);
      }
    });
    /* A click on the dimmed page around the panel closes it. */
    dlg.addEventListener("click", function (e) {
      var r = dlg.getBoundingClientRect();
      if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
    });
    dlg.addEventListener("close", function () {
      zd.zone = null;
      hideTip();
      if (/^#zone=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    });
    window.addEventListener("hashchange", zdFromHash);
  }
  function zdFromHash() {
    var m = /^#zone=([A-Z0-9]+)$/.exec(location.hash);
    if (m) zdOpen(m[1]);
  }

  /* ---------- boot ---------- */

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.json();
    });
  }

  renderWaitlist();
  renderFooter();
  bindTerms(document);
  bindTheme();
  bindTimeZone();
  bindZonePicker();
  bindTopbar();
  document.addEventListener("pointerdown", function (e) {
    if (!(e.target.closest && e.target.closest(".term, [data-tip]"))) hideTip();
  });

  /* The revision log, or null when it cannot be loaded (the page then works without one). */
  function loadRevisions() {
    return fetchJson("/data/revisions.json").then(function (rev) {
      return rev && rev.schema === 1 ? { list: rev.revisions, kept: rev.kept || null } : null;
    }).catch(function () { return null; });
  }

  /* Fetches both files again and redraws the page when the summary is newer than the one shown.
     Everything renderAll draws is replaced rather than added to, and the listeners on the page
     are bound once, so a redraw is the same as the one a time-zone change already does. */
  var refreshedAt = Date.now();
  function refresh() {
    refreshedAt = Date.now();
    Promise.all([fetchJson("/data/summary.json"), loadRevisions()]).then(function (got) {
      var summary = got[0];
      if (!summary || summary.schema !== 1 || !(Date.parse(summary.generated_at) > Date.parse(state.summary.generated_at))) return;
      state.summary = summary;
      if (got[1]) { state.revisions = got[1].list; state.kept = got[1].kept; }
      renderAll();
      renderCitation(summary);
    }).catch(function (err) {
      if (window.console) console.warn("data refresh failed:", err.message || err);
    });
  }

  /* Both files are requested at once; a revision log that fails to load is an empty one. */
  var revisionsRequest = loadRevisions().then(function (rev) { return rev || { list: [], kept: null }; });
  fetchJson("/data/summary.json").then(function (summary) {
    if (!summary || summary.schema !== 1) throw new Error("unsupported data schema");
    state.summary = summary;
    return revisionsRequest.then(function (rev) {
      state.revisions = rev.list;
      state.kept = rev.kept;
      document.querySelectorAll("[data-needs-data]").forEach(function (el) { el.hidden = false; });
      renderAll();
      renderCitation(summary);
      bindZonePanel();
      zdFromHash();
      var w = window.innerWidth, t;
      window.addEventListener("resize", function () {
        if (window.innerWidth === w) return;
        w = window.innerWidth;
        clearTimeout(t);
        t = setTimeout(function () { renderCharts(); zdRender(); }, 150);
      });
      setInterval(function () {
        renderStatus(state.summary);
        renderStats(view().s);
      }, 60000);
      /* While the page is open and visible, look for newer data as often as it is published. */
      setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && Date.now() - refreshedAt >= REFRESH_MS) refresh();
      });
    });
  }).catch(function (err) {
    if (window.console) console.warn("summary data unavailable:", err.message || err);
    $("empty-state").hidden = false;
    renderCitation({});
  });
})();
