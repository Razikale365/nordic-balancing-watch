/* Nordic Balancing Watch — vanilla JS, no build step. */
(function () {
  "use strict";

  var CFG = window.NBW_CONFIG || {};
  var STALE_MS = 3 * 60 * 60 * 1000;
  var PAGE = 100;
  var PALETTE = ["#1d5fae", "#d97706", "#059669", "#7c3aed", "#dc2626",
    "#0891b2", "#be185d", "#65a30d", "#9333ea", "#b45309"];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(n) { return n == null ? "—" : Number(n).toLocaleString("en-GB"); }
  function fmtPct(share) { return share == null ? "—" : (share * 100).toFixed(1) + " %"; }
  function fmtPrice(p) {
    return p == null ? "—" : p.toLocaleString("en-GB", { maximumFractionDigits: 4 });
  }
  function delayText(min) {
    if (min == null) return "—";
    if (min < 0) return (-min / 60).toFixed(1) + " h ahead";
    return min.toFixed(1) + " min after";
  }
  function lagText(h) { return h == null ? "—" : h.toFixed(1) + " h"; }
  function utcShort(iso) { return iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC"; }
  function relTime(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return (s / 3600).toFixed(1) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function chartColors() {
    return { ink: cssVar("--text"), muted: cssVar("--muted"), border: cssVar("--border") };
  }

  var charts = [];
  function makeChart(canvasId, height, cfg) {
    if (!window.Chart) return null;
    var el = $(canvasId);
    el.parentElement.style.height = height + "px";
    cfg.options = cfg.options || {};
    cfg.options.responsive = true;
    cfg.options.maintainAspectRatio = false;
    var c = new Chart(el.getContext("2d"), cfg);
    charts.push(c);
    return c;
  }

  function fillSelect(sel, values, allLabel) {
    sel.innerHTML = "";
    var o = document.createElement("option");
    o.value = "";
    o.textContent = allLabel;
    sel.appendChild(o);
    values.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
  }

  function tableRows(tbody, rows) {
    tbody.innerHTML = rows.map(function (r) {
      return "<tr>" + r.map(function (c) { return "<td" + (c.cls ? ' class="' + c.cls + '"' : "") + ">" + c.html + "</td>"; }).join("") + "</tr>";
    }).join("");
  }
  function cell(html, cls) { return { html: html, cls: cls || "" }; }

  /* ---------- data loading ---------- */

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.json();
    });
  }

  /* ---------- sections ---------- */

  function renderHeader(s) {
    var since = $("collecting-since");
    since.textContent = s.collecting_since ? s.collecting_since.slice(0, 10) : "—";
    since.dateTime = s.collecting_since || "";
    var upd = $("updated");
    upd.textContent = relTime(s.generated_at) + " (" + utcShort(s.generated_at) + ")";
    upd.dateTime = s.generated_at;
    var age = Date.now() - Date.parse(s.generated_at);
    if (age > STALE_MS) {
      var b = $("stale-banner");
      b.textContent = "This data was generated " + relTime(s.generated_at) +
        " and may be stale — the hourly refresh has not landed yet.";
      b.hidden = false;
    }
  }

  function renderKeyFigures(s) {
    var groups = s.groups || [];
    var revisions7 = 0, published = 0, revised = 0;
    groups.forEach(function (g) {
      if (g.last7) revisions7 += g.last7.revisions || 0;
      if (g.data === "imbalance" && g.last7) {
        published += g.last7.published || 0;
        revised += g.last7.revised || 0;
      }
    });
    var p = s.polls_24h || {};
    var total = (p.ok || 0) + (p.skipped || 0) + (p.error || 0);
    var success = total ? (p.ok || 0) / total : null;
    var share = published ? revised / published : null;

    var stats = [
      ["Values tracked", fmtInt(s.observations_total), "observations on record"],
      ["Revisions, last 7 days", fmtInt(revisions7), "price changes after first publication"],
      ["First prices later revised", fmtPct(share),
        "imbalance, all sources (" + fmtInt(revised) + " of " + fmtInt(published) + ")"],
      ["Poll success, last 24 h", fmtPct(success),
        fmtInt(p.ok) + " of " + fmtInt(total) + " polls ok"]
    ];
    $("key-figures").innerHTML = stats.map(function (t) {
      return "<div><dt>" + esc(t[0]) + "</dt><dd>" + esc(t[1]) +
        "<small>" + esc(t[2]) + "</small></dd></div>";
    }).join("");
  }

  function imbalanceGroups(s) {
    return (s.groups || []).filter(function (g) {
      return g.data === "imbalance" && g.last7 && g.last7.n > 0;
    });
  }

  var delayChart;
  function renderDelaySection(s) {
    var groups = imbalanceGroups(s);
    var sources = [];
    groups.forEach(function (g) { if (sources.indexOf(g.source) < 0) sources.push(g.source); });
    fillSelect($("delay-source"), sources, "All sources");
    $("delay-source").addEventListener("change", function () {
      drawDelay(groups, this.value || null);
    });
    drawDelay(groups, null);
  }

  function drawDelay(groups, source) {
    var rows = groups.filter(function (g) {
      return !source || g.source === source;
    }).slice().sort(function (a, b) { return a.last7.p50 - b.last7.p50; });
    var labels = rows.map(function (g) { return g.source + " " + g.zone; });
    if (delayChart) delayChart.destroy();
    var c = chartColors();
    delayChart = makeChart("delay-chart", Math.max(160, rows.length * 44 + 50), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { label: "P50 delay (min)", data: rows.map(function (g) { return g.last7.p50; }),
            backgroundColor: cssVar("--chart-a") },
          { label: "P95 delay (min)", data: rows.map(function (g) { return g.last7.p95; }),
            backgroundColor: cssVar("--chart-b") }
        ]
      },
      options: {
        indexAxis: "y",
        scales: {
          x: { title: { display: true, text: "minutes after interval end", color: c.muted },
               ticks: { color: c.muted }, grid: { color: c.border } },
          y: { ticks: { color: c.ink }, grid: { display: false } }
        },
        plugins: { legend: { labels: { color: c.ink } } }
      }
    });
    tableRows($("delay-table").tBodies[0], rows.map(function (g) {
      return [cell(esc(g.source)), cell(esc(g.zone)),
        cell(delayText(g.last7.p50), "num"), cell(delayText(g.last7.p95), "num"),
        cell(fmtInt(g.last7.n), "num")];
    }));
  }

  function renderShareSection(s) {
    var groups = (s.groups || []).filter(function (g) {
      return g.data === "imbalance" && g.last7 && g.last7.published > 0;
    }).slice().sort(function (a, b) {
      return (b.last7.revised_share || 0) - (a.last7.revised_share || 0);
    });
    var sources = [];
    groups.forEach(function (g) { if (sources.indexOf(g.source) < 0) sources.push(g.source); });
    var colorOf = {};
    sources.forEach(function (src, i) { colorOf[src] = PALETTE[i % PALETTE.length]; });
    var c = chartColors();
    makeChart("share-chart", Math.max(160, groups.length * 40 + 50), {
      type: "bar",
      data: {
        labels: groups.map(function (g) { return g.source + " " + g.zone; }),
        datasets: [{
          label: "revised share (%)",
          data: groups.map(function (g) { return (g.last7.revised_share || 0) * 100; }),
          backgroundColor: groups.map(function (g) { return colorOf[g.source]; })
        }]
      },
      options: {
        indexAxis: "y",
        scales: {
          x: { min: 0, max: 100,
               title: { display: true, text: "% of first prices later revised", color: c.muted },
               ticks: { color: c.muted }, grid: { color: c.border } },
          y: { ticks: { color: c.ink }, grid: { display: false } }
        },
        plugins: { legend: { display: false } }
      }
    });
    tableRows($("share-table").tBodies[0], groups.map(function (g) {
      return [cell(esc(g.source)), cell(esc(g.zone)),
        cell(fmtPct(g.last7.revised_share), "num"), cell(fmtInt(g.last7.revised), "num"),
        cell(fmtInt(g.last7.published), "num")];
    }));
  }

  function renderReserveTable(s) {
    var groups = (s.groups || []).filter(function (g) { return g.data !== "imbalance"; });
    tableRows($("reserve-table").tBodies[0], groups.map(function (g) {
      var l = g.last7 || {};
      return [cell(esc(g.source)), cell(esc(g.data)), cell(esc(g.zone)),
        cell(delayText(l.p50), "num"), cell(fmtPct(l.revised_share), "num"),
        cell(lagText(l.lag_p50_h), "num")];
    }));
  }

  function renderTrendSection(s) {
    /* One line per source+product; each day's value is the n-weighted mean of the
       zones' p50 delays for that source and product. */
    var acc = {};   // key -> day -> {sum, n}
    var days = [];
    (s.groups || []).forEach(function (g) {
      var key = g.source + " — " + g.data;
      (g.daily || []).forEach(function (d) {
        if (days.indexOf(d.day) < 0) days.push(d.day);
        var slot = (acc[key] = acc[key] || {})[d.day] = acc[key][d.day] || { sum: 0, n: 0 };
        if (d.p50 != null && d.n) { slot.sum += d.p50 * d.n; slot.n += d.n; }
      });
    });
    days.sort();
    var keys = Object.keys(acc).sort();
    var datasets = keys.map(function (key, i) {
      return {
        label: key,
        data: days.map(function (day) {
          var slot = acc[key][day];
          return slot && slot.n ? +(slot.sum / slot.n).toFixed(1) : null;
        }),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: PALETTE[i % PALETTE.length],
        spanGaps: true,
        tension: 0.2,
        pointRadius: 2
      };
    });
    var c = chartColors();
    makeChart("trend-chart", 320, {
      type: "line",
      data: { labels: days, datasets: datasets },
      options: {
        scales: {
          x: { ticks: { color: c.muted, maxRotation: 45 }, grid: { color: c.border } },
          y: { title: { display: true, text: "P50 delay (minutes)", color: c.muted },
               ticks: { color: c.muted }, grid: { color: c.border } }
        },
        plugins: { legend: { labels: { color: c.ink, boxWidth: 14 } } }
      }
    });
    var rows = [];
    days.forEach(function (day) {
      keys.forEach(function (key) {
        var slot = acc[key][day];
        if (slot && slot.n) {
          var p = key.split(" — ");
          rows.push([cell(day), cell(esc(p[0])), cell(esc(p[1])),
            cell(delayText(+(slot.sum / slot.n).toFixed(1)), "num")]);
        }
      });
    });
    tableRows($("trend-table").tBodies[0], rows);
  }

  /* ---------- latest revisions feed ---------- */

  var revisions = [];
  var shown = PAGE;

  function renderFeed() {
    var fs = $("f-source").value, fd = $("f-data").value, fz = $("f-zone").value;
    var rows = revisions.filter(function (r) {
      return (!fs || r.source === fs) && (!fd || r.data === fd) && (!fz || r.zone === fz);
    });
    var slice = rows.slice(0, shown);
    tableRows($("rev-tbody"), slice.map(function (r) {
      var oldNew, pct = "";
      if (r.kind === "withdrawn") {
        oldNew = fmtPrice(r.old) + " " + esc(r.unit) + ' → <span class="muted">withdrawn</span>';
      } else {
        oldNew = fmtPrice(r.old) + " → " + fmtPrice(r.new) + " " + esc(r.unit);
        if (r.old != null && r.new != null && r.old !== 0) {
          var pc = (r.new - r.old) / Math.abs(r.old) * 100;
          pct = ' <span class="' + (pc > 0 ? "up" : "down") + '">(' +
            (pc > 0 ? "+" : "") + pc.toFixed(1) + "%)</span>";
        }
      }
      var lagH = (Date.parse(r.revised_at) - Date.parse(r.first_published_at)) / 3600000;
      return [
        cell(esc(utcShort(r.interval_start)) + '<span class="muted"> · ' + esc(r.interval_minutes) + " min</span>"),
        cell(esc(r.source)), cell(esc(r.data)), cell(esc(r.zone)),
        cell(oldNew + pct), cell(isFinite(lagH) ? lagH.toFixed(1) + " h" : "—", "num"),
        cell(esc(utcShort(r.revised_at)))
      ];
    }));
    $("rev-empty").hidden = rows.length > 0;
    var more = $("rev-more");
    more.hidden = rows.length <= slice.length;
    more.textContent = "Show more (" + (rows.length - slice.length) + " left)";
  }

  function renderRevisions(list) {
    revisions = list || [];
    var sources = [], datas = [], zones = [];
    revisions.forEach(function (r) {
      if (sources.indexOf(r.source) < 0) sources.push(r.source);
      if (datas.indexOf(r.data) < 0) datas.push(r.data);
      if (zones.indexOf(r.zone) < 0) zones.push(r.zone);
    });
    fillSelect($("f-source"), sources.sort(), "All");
    fillSelect($("f-data"), datas.sort(), "All");
    fillSelect($("f-zone"), zones.sort(), "All");
    ["f-source", "f-data", "f-zone"].forEach(function (id) {
      $(id).addEventListener("change", function () { shown = PAGE; renderFeed(); });
    });
    $("rev-more").addEventListener("click", function () { shown += PAGE; renderFeed(); });
    renderFeed();
  }

  /* ---------- waitlist ---------- */

  function renderWaitlist() {
    if (CFG.waitlist === false) { $("waitlist-section").hidden = true; return; }
    if (CFG.contactEmail) {
      $("wl-contact").innerHTML = ' by writing to <a href="mailto:' +
        encodeURIComponent(CFG.contactEmail) + '">' + esc(CFG.contactEmail) + "</a>";
    }
    $("waitlist-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("wl-msg");
      msg.className = "";
      var body = {
        email: $("wl-email").value.trim(),
        role: $("wl-role").value,
        website: $("wl-website").value
      };
      if (!body.email) { msg.textContent = "Please enter an email address."; msg.className = "err"; return; }
      fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (j) {
          if (res.ok && j.ok) {
            msg.textContent = "Thanks — you're on the list.";
            msg.className = "ok";
            e.target.reset();
          } else {
            msg.textContent = "Could not save that address" +
              (j && j.error ? ": " + j.error : ".") ;
            msg.className = "err";
          }
        });
      }).catch(function () {
        msg.textContent = "Could not reach the server. Please try again later.";
        msg.className = "err";
      });
    });
  }

  function renderFooter() {
    if (CFG.collectorUrl) {
      $("collector-link").innerHTML = ' · <a href="' + esc(CFG.collectorUrl) +
        '" rel="noopener">data collector</a>';
    }
  }

  /* ---------- boot ---------- */

  function showEmpty() {
    $("content").hidden = true;
    $("empty-state").hidden = false;
    renderWaitlist();
    renderFooter();
  }

  if (window.Chart) {
    var c = chartColors();
    Chart.defaults.color = c.ink;
    Chart.defaults.borderColor = c.border;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  }

  fetchJson("/data/summary.json").then(function (summary) {
    if (!summary || summary.schema !== 1) throw new Error("unsupported data schema");
    $("content").hidden = false;
    renderHeader(summary);
    renderKeyFigures(summary);
    renderDelaySection(summary);
    renderShareSection(summary);
    renderReserveTable(summary);
    renderTrendSection(summary);
    renderFooter();
    renderWaitlist();
    return fetchJson("/data/revisions.json").then(function (rev) {
      renderRevisions(rev && rev.schema === 1 ? rev.revisions : []);
    }).catch(function () { renderRevisions([]); });
  }).catch(function (err) {
    if (window.console) console.warn("summary data unavailable:", err.message || err);
    showEmpty();
  });
})();
