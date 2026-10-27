/* Nordic Balancing Watch: plain JS, no build step, no dependencies. */
(function () {
  "use strict";

  var CFG = window.NBW_CONFIG || {};
  var STALE_MS = 3 * 60 * 60 * 1000;

  /* Sources are grouped into three categories so colour stays meaningful:
     eSett, ENTSO-E and the national TSOs (each TSO covers its own zones). */
  var CAT = { esett: "esett", entsoe: "entsoe", energidataservice: "tso", fingrid: "tso", svk: "tso" };
  var CAT_ORDER = ["esett", "entsoe", "tso"];
  var CAT_LABEL = { esett: "eSett", entsoe: "ENTSO-E", tso: "National TSO" };
  var CAT_SHAPE = { esett: "circle", entsoe: "square", tso: "diamond" };
  var SRC_LABEL = {
    esett: "eSett", entsoe: "ENTSO-E", energidataservice: "Energinet",
    fingrid: "Fingrid", svk: "Svenska kraftnät"
  };
  var COUNTRY = { DK: "Denmark", FI: "Finland", NO: "Norway", SE: "Sweden" };
  var ZONES = ["DK1", "DK2", "FI", "NO1", "NO2", "NO3", "NO4", "NO5", "SE1", "SE2", "SE3", "SE4"];

  /* The glossary is written in the page itself, so it reads without JavaScript; the tooltips
     on glossary terms take their definitions from it. */
  var GLOSSARY = {};
  document.querySelectorAll("#glossary > div[id^='g-']").forEach(function (d) {
    var text = function (sel) { return d.querySelector(sel).textContent.replace(/\s+/g, " ").trim(); };
    GLOSSARY[d.id.slice(2)] = [text("dt"), text("dd")];
  });

  var state = { tz: load("nbw.tz", "UTC"), zones: load("nbw.zones", null), summary: null, revisions: [], tables: {}, cov: { label: "last 7 days" } };
  function inZones(z) { return !state.zones || state.zones.indexOf(z) >= 0; }
  function term(key, text) { return '<span class="term" data-term="' + key + '">' + text + "</span>"; }

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
  function cat(source) { return CAT[source] || "tso"; }
  function catColor(c) { return "var(--s-" + c + ")"; }
  function country(zone) { return COUNTRY[zone.slice(0, 2)] || zone; }
  function zoneIndex(z) { var i = ZONES.indexOf(z); return i < 0 ? 99 : i; }

  function fmtInt(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-GB"); }
  function fmtPct(x, digits) {
    if (x == null) return "—";
    return (x * 100).toFixed(digits == null ? (x > 0 && x < 0.1 ? 1 : 0) : digits) + "%";
  }
  /* "2 in 5", "1 in 6": the nearest simple fraction, for plain-language sentences. */
  function simpleFraction(x) {
    var c = [[1, 2], [2, 5], [1, 3], [1, 4], [1, 5], [1, 6], [1, 8], [1, 10], [1, 20], [1, 50], [1, 100]];
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
     base is large enough for a percentage to mean something. */
  function chg(from, to, opts) {
    if (from == null || to == null) return "";
    var d = to - from, dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    var p = Math.abs(from) >= 1 ? d / Math.abs(from) : null;
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
    tip = tip || $("tooltip");
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
    var W = Math.max(280, el.clientWidth), ROW = 30, BAR = 12, AX = 26;
    var L = Math.min(170, Math.round(W * 0.38)), VAL = Math.min(130, Math.round(W * 0.3));
    var plotW = W - L - VAL;
    var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    var step = opt.step ? opt.step(maxV) : niceStep(maxV, 4);
    var xmax = Math.max(step, Math.ceil(maxV / step) * step);
    var x = function (v) { return L + v / xmax * plotW; };
    var body = "", tips = [], y = 2;
    rows.forEach(function (r) {
      var cy = y + ROW / 2, x0 = L, x1 = Math.max(L + 2, x(r.value)), top = cy - BAR / 2, rad = 4;
      tips.push(r.tip);
      body += '<rect class="row-hit" x="0" y="' + y + '" width="' + W + '" height="' + ROW +
        '" rx="4" tabindex="0" data-tip="' + (tips.length - 1) + '" aria-label="' + esc(r.aria) + '"/>';
      body += '<g pointer-events="none"><text class="row-label" x="6" y="' + (cy + 4) + '">' + esc(r.label) + "</text>";
      var rr = Math.min(rad, (x1 - x0) / 2);
      body += '<path d="M' + x0 + " " + top + "H" + (x1 - rr) + "Q" + x1 + " " + top + " " + x1 + " " + (top + rr) +
        "V" + (top + BAR - rr) + "Q" + x1 + " " + (top + BAR) + " " + (x1 - rr) + " " + (top + BAR) + "H" + x0 +
        'Z" fill="' + r.color + '"/>';
      body += '<text class="val-label" x="' + (x1 + 8) + '" y="' + (cy + 4) + '">' + esc(r.text) + "</text></g>";
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
    var W = Math.max(200, el.clientWidth), L = 4, R = 4, T = 4, B = opt.axis === false ? 4 : 22, GAP = 2;
    var H = (opt.height || 150) + B;
    var totals = buckets.map(function (b) { return sum(cats.map(function (c) { return b.counts[c] || 0; })); });
    var ymax = Math.max.apply(null, totals.concat([1]));
    var plotH = H - T - B, colW = (W - L - R) / buckets.length;
    var grid = "", ticks = "", body = "", tips = [];
    var barW = Math.max(1, colW - (colW > 4 ? 1.5 : 0.5));
    buckets.forEach(function (b, i) {
      var x0 = L + i * colW, base = T + plotH;
      if (b.dayLabel) {
        if (opt.axis !== false) ticks += '<text x="' + (x0 + 3) + '" y="' + (H - 6) + '">' + esc(b.dayLabel) + "</text>";
        grid += '<line x1="' + x0 + '" x2="' + x0 + '" y1="' + T + '" y2="' + (T + plotH) + '"/>';
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
    var cols = this.visible(), rows = this.view();
    var cellOf = function (v) {
      /* Derived numbers (hours, shares) carry float noise such as 25.334999999999997. */
      if (typeof v === "number" && isFinite(v) && v !== Math.round(v)) v = Number(v.toFixed(6));
      var s = v == null ? "" : String(v);
      /* Text that a spreadsheet would read as a formula is prefixed with an apostrophe. */
      if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var text = [cols.map(function (c) { return cellOf(c.csvLabel || c.label); }).join(",")].concat(rows.map(function (r) {
      return cols.map(function (c) { return cellOf(c.csv ? c.csv(r) : c.get(r)); }).join(",");
    })).join("\n");
    var url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = this.cfg.csvName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

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
    $("sample-note").innerHTML = c.full
      ? "Figures use the last 7 days of data" + (sample ? " (" + sample + ")" : "") + "." + seen
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
    document.querySelectorAll("[data-revcap]").forEach(function (el) {
      el.textContent = capped ? "The log keeps only the newest " + fmtInt(logged) + " entries, back to " + dateTime(oldest) + " " + tzName(oldest) +
        ", while " + fmtInt(counted) + " changes were counted in the window. The revision log, its CSV and the charts built from it cover only those entries." : "";
    });
    $("coverage-note").textContent = !c.since ? "The data does not say when collection started, so how much of the window is filled is unknown."
      : c.full ? "Collection started on " + since + "; the 7-day window is full."
      : "Collection started on " + since + ". The current data covers " + c.span + ", so the 7-day window is not yet full and every figure on this page comes from that shorter sample.";
  }

  function renderStatus(s) {
    var age = Date.now() - Date.parse(s.generated_at), stale = age > STALE_MS;
    $("live-dot").classList.toggle("stale", stale);
    $("status-line").innerHTML = (stale ? "Delayed" : "Live") + " · updated " +
      '<time datetime="' + esc(s.generated_at) + '">' +
      esc(fmtTime(s.generated_at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + " " + tzName(s.generated_at)) +
      "</time> (" + esc(relTime(s.generated_at)) + ")" +
      (validTime(s.collecting_since) ? " · collecting since " + esc(longDate(s.collecting_since)) : "");
    var b = $("stale-banner");
    if (stale) {
      b.firstChild.textContent = "This data was generated " + relTime(s.generated_at) +
        "; the hourly refresh has not arrived yet, so the newest prices may be missing.";
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
      var wins = {};
      zones.forEach(function (z) { var c = cat(fastest[z].source); wins[c] = (wins[c] || 0) + 1; });
      var lead = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; })[0];
      /* Which source is first, zone by zone, as one segmented bar. */
      var bar = '<span class="tile-bar" aria-hidden="true">' + CAT_ORDER.filter(function (c) { return wins[c]; }).map(function (c) {
        return '<i style="flex:' + wins[c] + ";background:" + catColor(c) + '" title="' + esc(CAT_LABEL[c]) + " first in " + wins[c] + '"></i>';
      }).join("") + "</span>";
      tiles.push(["First price seen after", fmtMin(median(zones.map(function (z) { return fastest[z].last7.p50; }))),
        "Median zone · " + CAT_LABEL[lead] + " first in " + wins[lead] + " of " + zones.length, bar]);
    }
    var es = (byCat.esett || []).map(function (g) { return g.last7.p50; }).filter(function (v) { return v != null; });
    if (es.length) {
      var lo = Math.round(Math.min.apply(null, es)), hi = Math.round(Math.max.apply(null, es));
      tiles.push(["eSett prices seen after", (lo === hi ? lo : lo + "–" + hi) + "<small>min</small>", "Typical, depending on the zone"]);
    }
    var pub = sum(imb.map(function (g) { return g.last7.published || 0; }));
    var rev = sum(imb.map(function (g) { return g.last7.revised || 0; }));
    if (pub) {
      tiles.push(["First prices changed later", fmtPct(rev / pub, 1), fmtInt(rev) + " of " + fmtInt(pub) + " imbalance prices",
        '<span class="tile-meter" aria-hidden="true"><i style="width:' + Math.max(rev ? 2 : 0, Math.round(rev / pub * 100)) + '%"></i></span>']);
    }
    var revisions = sum((s.groups || []).map(function (g) { return (g.last7 && g.last7.revisions) || 0; }));
    var p = s.polls_24h || {}, total = (p.ok || 0) + (p.skipped || 0) + (p.error || 0);
    var health = total ? (p.ok / total >= 0.98 ? "up" : p.ok / total >= 0.9 ? "amber" : "down") : "";
    var win = state.cov.label.charAt(0).toUpperCase() + state.cov.label.slice(1);
    tiles.push(["Price changes logged", fmtInt(revisions), win + (total ? " · " + fmtPct(p.ok / total) + " of checks OK in the last 24 h" : ""),
      health ? '<span class="tile-health"><span class="dot ' + health + '"></span>Collector ' +
        (health === "up" ? "healthy" : health === "amber" ? "partly failing" : "failing") + "</span>" : ""]);
    $("stats").innerHTML = tiles.map(function (t) {
      return '<div class="stat"><dt>' + esc(t[0]) + '</dt><dd><span class="v">' + t[1] + "</span>" + (t[3] || "") +
        '<span class="s">' + esc(t[2]) + "</span></dd></div>";
    }).join("");
  }

  function renderFindings(s, revs) {
    var imb = imbalanceGroups(s), out = [];
    var fastest = fastestByZone(imb), zones = Object.keys(fastest);
    var wins = {};
    zones.forEach(function (z) { var c = cat(fastest[z].source); wins[c] = (wins[c] || 0) + 1; });
    var lead = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; })[0];
    if (lead) {
      var leadP50 = imb.filter(function (g) { return cat(g.source) === lead; }).map(function (g) { return g.last7.p50; });
      var lo = Math.round(Math.min.apply(null, leadP50)), hi = Math.round(Math.max.apply(null, leadP50));
      out.push("The " + term("imbalance", "imbalance price") + " usually shows up first on <b>" + esc(CAT_LABEL[lead]) +
        "</b>: in <b>" + wins[lead] + " of " + zones.length + "</b> " + term("zone", "price zones") + ", about <b>" +
        (lo === hi ? lo : lo + "–" + hi) + " minutes</b> after each 15 minutes end.");
    }
    var gaps = imb.filter(function (g) { return g.source === "esett" && fastest[g.zone] && fastest[g.zone].source !== "esett"; })
      .map(function (g) { return g.last7.p50 - fastest[g.zone].last7.p50; });
    if (gaps.length) {
      out.push(term("esett", "eSett") + ", where the money is settled, shows the same prices <b>" +
        Math.round(Math.min.apply(null, gaps)) + "–" + Math.round(Math.max.apply(null, gaps)) + " minutes later</b>.");
    }
    var top = imb.filter(function (g) { return g.last7.published >= 20 && g.last7.revised_share > 0; })
      .sort(function (a, b) { return b.last7.revised_share - a.last7.revised_share; })[0];
    if (top) {
      var clean = CAT_ORDER.filter(function (c) {
        var gs = imb.filter(function (g) { return cat(g.source) === c; });
        return gs.length && gs.every(function (g) { return !g.last7.revisions; });
      }).map(function (c) { return CAT_LABEL[c]; });
      var share = top.last7.revised_share;
      var plain = "About " + simpleFraction(share);
      out.push("<b>" + plain + "</b> (" + fmtPct(share) + ", " + fmtInt(top.last7.revised) + " of " + fmtInt(top.last7.published) + ") of the first prices " + esc(SRC_LABEL[top.source]) + " showed for <b>" +
        esc(country(top.zone)) + (country(top.zone) !== top.zone ? " (" + esc(top.zone) + ")" : "") + "</b> were changed later" +
        (top.last7.lag_p50_h != null ? ", typically <b>" + fmtHours(top.last7.lag_p50_h) + "</b> after" : "") + "." +
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
    var res = reserveGroups(s).filter(function (g) { return g.last7.revisions > 0; });
    if (res.length) {
      var bySrc = {};
      res.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g); });
      var src = Object.keys(bySrc).sort(function (a, b) {
        return sum(bySrc[b].map(function (g) { return g.last7.revisions; })) - sum(bySrc[a].map(function (g) { return g.last7.revisions; }));
      })[0];
      var gs = bySrc[src], n = sum(gs.map(function (g) { return g.last7.revisions; }));
      var products = uniq(gs.map(function (g) { return g.data.split(" ")[0]; }));
      var lag = median(gs.map(function (g) { return g.last7.lag_p50_h; }).filter(function (v) { return v != null; }));
      var leadMin = median(gs.map(function (g) { return g.last7.p50; }).filter(function (v) { return v != null && v < 0; }));
      out.push("Prices for " + term("reserve", "standby power") + " (" + esc(products.join(" and ")) + " in " +
        esc(zoneRange(gs.map(function (g) { return g.zone; }))) + ") come out" +
        (leadMin != null ? " about <b>" + fmtHours(-leadMin / 60) + " before delivery</b>" : " ahead of delivery") +
        " and are then updated" + (lag != null ? " about <b>" + fmtHours(lag) + "</b> later" : "") +
        ", when the next " + term("auction", "auction") + " clears (" + fmtInt(n) + " zone-quarter-hours re-priced).");
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
      return '<tr><td class="zone-col"><b>' + esc(z) + "</b><span>" + esc(country(z)) + "</span></td>" + cats.map(function (c) {
        var e = entries.filter(function (x) { return cat(x.source) === c; })[0];
        if (!e) return '<td class="muted">—</td>';
        var zero = e.price === 0 && e.source === "esett";
        zeroSeen = zeroSeen || zero;
        var limit = p95[e.source + "|" + z];
        var late = limit != null && e.minutes_since_end > limit + 30;
        var isNewest = entries.length > 1 && e === newest && entries.filter(function (x) { return x.interval_start === e.interval_start; }).length === 1;
        return '<td><div class="px-line"><span class="px">' + fmtPrice(e.price) + (zero ? "*" : "") + "</span>" +
          chg(e.prev_price, e.price) + "</div>" + sparkline(e.recent) +
          '<span class="px-sub">For ' + esc(fmtTime(e.interval_start, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })) +
          " · " + esc(fmtDur(e.minutes_since_end)) + " ago" + (cat(e.source) === "tso" ? " · " + esc(SRC_LABEL[e.source]) : "") + "</span>" +
          (isNewest ? '<span class="badge newest">Newest</span> ' : "") +
          (late ? '<span class="badge late" title="Older than this source usually is">⚠ Later than usual</span>' : "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
    table.innerHTML = head + "<tbody>" + body + "</tbody>";
    $("board-legend").innerHTML = "";
    $("board-note").textContent = (zeroSeen ? "* In this data, eSett values of 0.00 have often been replaced by a different value later. " : "") +
      "The change is against the interval before; the line shows up to the last 4 hours. " +
      "Times are when each 15-minute interval started, and how long ago it ended. " +
      "“Later than usual” means the newest price is more than 30 minutes older than this source’s 95th percentile.";
  }

  function renderRecent(s, revs) {
    var since = Date.parse(s.generated_at) - 3 * 3600000;
    var recent = revs.filter(function (r) { return inZones(r.zone) && Date.parse(r.revised_at) >= since; })
      .sort(function (a, b) { return a.revised_at < b.revised_at ? 1 : -1; });
    var shown = recent.slice(0, 8);
    var hm = function (iso) { return fmtTime(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); };
    $("recent").innerHTML = shown.length ? shown.map(function (r) {
      return '<li><span class="t">' + esc(hm(r.revised_at)) + "</span><span>" + srcCell(r.source) + " · " + esc(r.zone) +
        ' <span class="muted">' + esc(r.data === "imbalance" ? "for " + hm(r.interval_start) : r.data) + "</span></span>" +
        '<span class="v"><span class="muted">' + fmtPrice(r.old) + " →</span> " +
        (r.new == null ? '<span class="tag withdrawn">Withdrawn</span>' : "<b>" + fmtPrice(r.new) + "</b> " + chg(r.old, r.new, { plain: true })) + "</span></li>";
    }).join("") + (recent.length > shown.length ? '<li class="more">+' + (recent.length - shown.length) + " more in the revision log</li>" : "")
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
    $("delay-callout").innerHTML = slow
      ? "Outlier: one " + esc(SRC_LABEL[slow.source]) + " " + esc(slow.zone) + " price took <b>" + fmtDur(slow.last7.max) +
        "</b>, against a 95th percentile of " + fmtMin(slow.last7.p95) + "."
      : "";
  }

  function renderShare(s) {
    var imb = imbalanceGroups(s).filter(function (g) { return g.last7.published >= 10; });
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
      empty: "No first price was changed in the " + state.cov.label + "."
    });
    var zero = imb.filter(function (g) { return !g.last7.revised; });
    var bySrc = {};
    zero.forEach(function (g) { (bySrc[g.source] = bySrc[g.source] || []).push(g.zone); });
    $("share-note").textContent = Object.keys(bySrc).length
      ? "No later change: " + Object.keys(bySrc).map(function (k) { return SRC_LABEL[k] + " (" + zoneRange(bySrc[k]) + ")"; }).join("; ") + "."
      : "";
  }

  function renderSize(revs) {
    var by = {};
    revs.forEach(function (r) {
      if (r.data !== "imbalance") return;
      var k = r.source + "|" + r.zone;
      var b = by[k] = by[k] || { n: 0, zero: 0, withdrawn: 0, sizes: [] };
      b.n++;
      if (r.kind === "withdrawn") b.withdrawn++;
      else if (r.old === 0) b.zero++;
      else b.sizes.push(Math.abs(r.new - r.old));
    });
    var rows = Object.keys(by).map(function (k) {
      var src = k.split("|")[0], zone = k.split("|")[1], b = by[k];
      var corrected = b.n - b.zero - b.withdrawn;
      return {
        label: SRC_LABEL[src] + " · " + zone, value: b.n, color: catColor(cat(src)),
        text: b.n + (b.zero === b.n ? ", all from 0.00" : b.zero ? ", " + b.zero + " from 0.00" : ""),
        aria: SRC_LABEL[src] + " " + zone + ": " + b.n + " changes, " + b.zero + " replaced 0.00",
        tip: '<div class="t-title">' + esc(SRC_LABEL[src]) + " · " + esc(zone) + "</div>" +
          tipRow(cat(src), "Replaced a 0.00 price", fmtInt(b.zero)) +
          tipRow(cat(src), "Changed a non-zero price", fmtInt(corrected)) +
          (b.withdrawn ? tipRow(cat(src), "Withdrawn", fmtInt(b.withdrawn)) : "") +
          (b.sizes.length ? '<div class="t-sub">Median correction ' + fmtPrice(median(b.sizes)) + " EUR/MWh</div>" : "")
      };
    }).sort(function (a, b) { return b.value - a.value; });
    hbars($("size-chart"), rows, {
      tick: function (t) { return String(Math.round(t)); },
      empty: "No imbalance price change in the log yet."
    });
  }

  function renderHistogram(s, revs) {
    var el = $("hist-chart");
    if (!revs.length) { el.innerHTML = '<p class="empty-chart">No revision has been recorded in the ' + esc(state.cov.label) + '.</p>'; return; }
    var HOUR = 3600000;
    var first = Math.floor(Math.min.apply(null, revs.map(function (r) { return Date.parse(r.revised_at); })) / HOUR) * HOUR;
    var last = Math.floor(Date.parse(s.generated_at) / HOUR) * HOUR;
    var buckets = [], index = {};
    for (var t = first; t <= last; t += HOUR) {
      var iso = new Date(t).toISOString();
      var hour = +fmtTime(iso, { hour: "2-digit", hourCycle: "h23" });
      index[t] = buckets.length;
      buckets.push({
        counts: {}, title: dateTime(iso) + " " + tzName(iso),
        dayLabel: hour === 0 ? fmtTime(iso, { day: "numeric", month: "short" }) : ""
      });
    }
    revs.forEach(function (r) {
      var b = buckets[index[Math.floor(Date.parse(r.revised_at) / HOUR) * HOUR]];
      if (b) b.counts[cat(r.source)] = (b.counts[cat(r.source)] || 0) + 1;
    });
    var cats = CAT_ORDER.filter(function (c) { return revs.some(function (r) { return cat(r.source) === c; }); });
    $("hist-legend").innerHTML = "";
    /* One strip per source with its own scale: a single large reserve batch must not
       flatten the hourly imbalance pattern. */
    el.innerHTML = cats.map(function (c, i) {
      var top = Math.max.apply(null, buckets.map(function (b) { return b.counts[c] || 0; }));
      return '<div class="strip"><div class="strip-label"><span class="src">' + swatch(c) + esc(CAT_LABEL[c]) +
        '</span><span class="muted">up to ' + fmtInt(top) + ' per hour</span></div><div class="strip-plot" data-strip="' + i + '"></div></div>';
    }).join("");
    cats.forEach(function (c, i) {
      stackedColumns(el.querySelector('[data-strip="' + i + '"]'), buckets, [c], { height: 64, axis: i === cats.length - 1 });
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
        { key: "max", label: "Slowest", csvLabel: "Slowest (min)", num: true, get: function (g) { return g.last7.max; }, html: function (g) { return fmtDur(g.last7.max); } },
        { key: "n", label: "Intervals", num: true, get: function (g) { return g.last7.n; }, html: function (g) { return fmtInt(g.last7.n); } },
        { key: "share", label: "Changed later", csvLabel: "Changed later (share)", num: true, get: function (g) { return g.last7.revised_share; },
          html: function (g) {
            var v = g.last7.revised_share;
            return v == null ? "—" : '<span class="meter ' + shareTone(v) + '">' + fmtPct(v, 1) + '<span class="b"><i style="width:' + Math.max(v > 0 ? 4 : 0, Math.round(v * 100)) + '%"></i></span></span>';
          } },
        { key: "revisions", label: "Changes", num: true, get: function (g) { return g.last7.revisions; }, html: function (g) { return fmtInt(g.last7.revisions); } },
        { key: "lag", label: "Typically after", csvLabel: "Typically changed after (h)", num: true, get: function (g) { return g.last7.lag_p50_h; }, html: function (g) { return fmtHours(g.last7.lag_p50_h); } }
      ]
    });
  }

  function renderLead(s) {
    var res = reserveGroups(s);
    var measured = res.filter(function (g) { return g.last7.n > 0 && g.last7.p50 != null && g.last7.p50 < 0; });
    var agg = {};
    measured.forEach(function (g) {
      var k = g.source + "|" + g.data;
      (agg[k] = agg[k] || { source: g.source, data: g.data, groups: [] }).groups.push(g);
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k], hours = -median(a.groups.map(function (g) { return g.last7.p50; })) / 60;
      var zones = zoneRange(a.groups.map(function (g) { return g.zone; }));
      return {
        label: SRC_LABEL[a.source] + " · " + a.data, value: hours, color: catColor(cat(a.source)),
        text: fmtHours(hours) + " · " + zones,
        aria: SRC_LABEL[a.source] + " " + a.data + ": " + fmtHours(hours) + " ahead, " + zones,
        tip: '<div class="t-title">' + esc(SRC_LABEL[a.source]) + " · " + esc(a.data) + "</div>" +
          tipRow(cat(a.source), "Median lead", fmtHours(hours)) +
          tipRow(cat(a.source), "Zones", esc(zones)) +
          tipRow(cat(a.source), "Delivery hours", fmtInt(sum(a.groups.map(function (g) { return g.last7.n; })) / a.groups.length))
      };
    }).sort(function (a, b) { return b.value - a.value; });
    hbars($("lead-chart"), rows, {
      tick: function (t) { return t + " h"; },
      step: function (m) { return m > 30 ? 12 : m > 12 ? 6 : 3; },
      empty: "No first publication of a capacity price has been measured yet."
    });
    var revised = res.filter(function (g) { return g.last7.revisions > 0; });
    var bySrc = {};
    revised.forEach(function (g) { (bySrc[g.source + "|" + g.data.split(" ")[0]] = bySrc[g.source + "|" + g.data.split(" ")[0]] || []).push(g); });
    $("lead-callout").innerHTML = Object.keys(bySrc).map(function (k) {
      var gs = bySrc[k], lag = median(gs.map(function (g) { return g.last7.lag_p50_h; }).filter(function (v) { return v != null; }));
      return esc(SRC_LABEL[gs[0].source]) + " " + esc(k.split("|")[1]) + " (" + esc(zoneRange(gs.map(function (g) { return g.zone; }))) +
        "): re-priced in <b>" + fmtInt(sum(gs.map(function (g) { return g.last7.revisions; }))) + " zone-quarter-hours</b>" +
        (lag != null ? ", typically " + fmtHours(lag) + " after first publication" : "") + ".";
    }).join("<br>");
    var pending = {};
    res.forEach(function (g) {
      if (!(g.last7.n > 0) && !(g.last7.revisions > 0)) pending[SRC_LABEL[g.source] + " " + g.data.split(" ")[0]] = true;
    });
    var names = Object.keys(pending).sort();
    $("lead-pending").textContent = names.length ? "Not measured yet in the " + state.cov.label + ": " + names.join(", ") + "." : "";
  }

  function renderReserveTable(s) {
    var rows = reserveGroups(s).filter(function (g) { return g.last7.n > 0 || g.last7.revisions > 0; });
    var ahead = function (m) { return m == null ? null : -m / 60; };
    if (state.tables.reserves) { state.tables.reserves.setRows(rows); return; }
    state.tables.reserves = new DataTable($("reserve-table"), {
      id: "reserves", rows: rows, page: 100, csvName: "nordic-reserve-publication.csv",
      sort: { key: "source", dir: "asc" }, filters: ["source", "product", "zone"],
      empty: "No capacity price has been measured yet.",
      columns: [
        { key: "source", label: "Source", get: function (g) { return SRC_LABEL[g.source]; }, html: function (g) { return srcCell(g.source); } },
        { key: "product", label: "Product", get: function (g) { return g.data; } },
        { key: "zone", label: "Zone", get: function (g) { return g.zone; }, filterSort: function (a, b) { return zoneIndex(a) - zoneIndex(b); } },
        { key: "lead", label: "Median lead", csvLabel: "Median lead (h before delivery)", num: true, get: function (g) { return ahead(g.last7.p50); }, html: function (g) { return fmtHours(ahead(g.last7.p50)); } },
        { key: "lead95", label: "95% at least", csvLabel: "95% at least (h before delivery)", num: true, get: function (g) { return ahead(g.last7.p95); }, html: function (g) { return fmtHours(ahead(g.last7.p95)); } },
        { key: "n", label: "Hours", num: true, get: function (g) { return g.last7.n; }, html: function (g) { return fmtInt(g.last7.n); } },
        { key: "revisions", label: "Re-pricings", num: true, get: function (g) { return g.last7.revisions; }, html: function (g) { return fmtInt(g.last7.revisions); } },
        { key: "lag", label: "Typically after", csvLabel: "Typically after (h)", num: true, get: function (g) { return g.last7.lag_p50_h; }, html: function (g) { return fmtHours(g.last7.lag_p50_h); } }
      ]
    });
  }

  function renderRevisionTable(revs) {
    var change = function (r) { return r.new == null ? null : r.new - r.old; };
    var after = function (r) { return (Date.parse(r.revised_at) - Date.parse(r.first_published_at)) / 3600000; };
    if (state.tables.revisions) { state.tables.revisions.setRows(revs); return; }
    state.tables.revisions = new DataTable($("rev-table"), {
      id: "revisions", rows: revs, page: 50, csvName: "nordic-balancing-revisions.csv",
      sort: { key: "revised_at", dir: "desc" }, filters: ["source", "data", "zone", "kind"],
      search: "Search zone, source, product…",
      empty: revs.length ? "No revision matches these filters." : "No revision has been recorded in the " + state.cov.label + ".",
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
        { key: "kind", label: "Type", get: function (r) { return r.kind === "withdrawn" ? "Withdrawn" : "Changed"; },
          html: function (r) { return '<span class="tag ' + esc(r.kind) + '">' + (r.kind === "withdrawn" ? "Withdrawn" : "Changed") + "</span>"; }, hidden: true },
        { key: "first", label: "First published", time: true, hidden: true, get: function (r) { return r.first_published_at; },
          html: function (r) { return esc(dateTime(r.first_published_at)); } }
      ]
    });
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
      $("wl-contact").innerHTML = ' by writing to <a href="mailto:' + esc(CFG.contactEmail) + '">' + esc(CFG.contactEmail) + "</a>";
    }
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
          if (res.ok && j.ok) { msg.textContent = "Thanks, you are on the list."; msg.className = "ok"; e.target.reset(); }
          else { msg.textContent = "Could not save that address" + (j && j.error ? ": " + j.error : "."); msg.className = "err"; }
        });
      }).catch(function () {
        msg.textContent = "Could not reach the server. Please try again later."; msg.className = "err";
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
        if (state.summary) renderAll();
      });
    });
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
      btn.setAttribute("data-active", String(!!state.zones));
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
    var v = view();
    renderDelay(v.s);
    renderShare(v.s);
    renderLead(v.s);
    renderTrend(v.s);
    renderSize(v.revs);
    renderHistogram(v.s, v.revs);
  }

  function renderAll() {
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
  document.addEventListener("pointerdown", function (e) {
    if (!(e.target.closest && e.target.closest(".term, [data-tip]"))) hideTip();
  });

  fetchJson("/data/summary.json").then(function (summary) {
    if (!summary || summary.schema !== 1) throw new Error("unsupported data schema");
    state.summary = summary;
    return fetchJson("/data/revisions.json").then(function (rev) {
      return rev && rev.schema === 1 ? rev.revisions : [];
    }).catch(function () { return []; }).then(function (revs) {
      state.revisions = revs;
      document.querySelectorAll("[data-needs-data]").forEach(function (el) { el.hidden = false; });
      renderAll();
      renderCitation(summary);
      var w = window.innerWidth, t;
      window.addEventListener("resize", function () {
        if (window.innerWidth === w) return;
        w = window.innerWidth;
        clearTimeout(t);
        t = setTimeout(renderCharts, 150);
      });
      setInterval(function () { renderStatus(summary); }, 60000);
    });
  }).catch(function (err) {
    if (window.console) console.warn("summary data unavailable:", err.message || err);
    $("empty-state").hidden = false;
    renderCitation({});
  });
})();
