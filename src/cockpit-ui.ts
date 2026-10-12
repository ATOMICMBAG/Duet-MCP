/**
 * The cockpit page of the live viewer: a static skeleton plus a small script that polls /api/cockpit and fills it in.
 * Every value from the machine or the server is written with textContent, never as HTML, because the texts come from the machine (message boxes) and from the assistant (G-code).
 * The page has no buttons that act on the machine.
 */
export const COCKPIT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<noscript><meta http-equiv="refresh" content="0;url=pictures"></noscript>
<title>duet-mcp cockpit</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1c1c1c;--mute:#666;--card:#fff;--line:#ddd;--off:#bbb;--ok:#2e9e4f;--warn:#e0901a;--bad:#d64040;--info:#3a78c9}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mute:#999;--card:#222;--line:#3a3a3a;--off:#555}}
body{margin:0;padding:14px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
h1{font-size:18px;margin:0}h2{font-size:14px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
.mute{color:var(--mute);font-size:13px}.top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.banner{border:2px solid var(--info);border-radius:8px;padding:10px 12px;margin-bottom:12px;background:var(--card)}
.banner b{font-size:16px}.banner.l-warning{border-color:var(--warn)}.banner.l-error{border-color:var(--bad)}.hidden{display:none}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.row span:first-child{color:var(--mute)}
.bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin:8px 0}.bar div{height:100%;width:0;background:var(--ok);transition:width .6s}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--off);margin-right:6px;vertical-align:-1px}
.dot.on{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.leds{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}.hot{color:var(--bad)}
.big img{width:100%;max-width:960px;border:1px solid var(--line);border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px}
.grid figure{margin:0;font-size:12px;color:var(--mute)}.grid img{width:100%;display:block;border-radius:4px;border:1px solid var(--line)}
ul{margin:0;padding-left:18px}li{margin:2px 0}li.l-warning b{color:var(--warn)}li.l-error b{color:var(--bad)}
</style></head><body>
<div class="top"><h1>duet-mcp cockpit</h1><div class="mute" id="clock">connecting ...</div></div>
<div id="banner" class="banner hidden"><b id="banner-title"></b><div id="banner-text"></div></div>
<div class="cols">
  <div class="card"><h2>Machine</h2><div id="machine"></div><div class="bar"><div id="bar-fill"></div></div></div>
  <div class="card"><h2>Heaters and fans</h2><div id="heaters"></div><div id="fans"></div></div>
  <div class="card"><h2>Axes and endstops</h2><div id="axes"></div><div class="leds" id="endstops"></div></div>
</div>
<div class="card" style="margin-bottom:12px"><h2>Camera</h2><div class="big" id="camera"></div></div>
<div class="card"><h2>Notices</h2><ul id="events"></ul><ul id="hints" class="mute" style="margin-top:8px"></ul></div>
<script src="app.js"></script>
</body></html>
`;

export const COCKPIT_JS = `(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function clock(ms) { return new Date(ms).toTimeString().slice(0, 8); }
  function row(parent, label, value, cls) { var r = el("div", "row"); r.appendChild(el("span", "", label)); r.appendChild(el("span", cls || "", value)); parent.appendChild(r); }
  var shown = null;

  function render(s) {
    $("clock").textContent = "updated " + clock(s.t) + (s.readOnly ? " - server is read-only" : "");
    var b = $("banner");
    if (s.banner) { b.className = "banner l-" + s.banner.level; $("banner-title").textContent = s.banner.title; $("banner-text").textContent = s.banner.text; }
    else b.className = "banner hidden";

    var m = $("machine"); clear(m);
    row(m, "Status", s.machine.status);
    if (s.machine.job) row(m, "Job", s.machine.job);
    if (s.machine.layer) row(m, "Layer", String(s.machine.layer));
    if (s.machine.progressPct !== undefined) row(m, "Progress", s.machine.progressPct + " %");
    if (s.machine.timeLeftMin !== undefined) row(m, "Time left (firmware estimate)", s.machine.timeLeftMin + " min");
    if (s.machine.speedPct !== undefined) row(m, "Speed factor", s.machine.speedPct + " %");
    if (s.machine.uptimeMin !== undefined) row(m, "Board running", s.machine.uptimeMin + " min");
    $("bar-fill").style.width = Math.max(0, Math.min(100, s.machine.progressPct || 0)) + "%";

    var h = $("heaters"); clear(h);
    s.heaters.forEach(function (x) {
      var r = el("div", "row"); var left = el("span", ""); var d = el("span", "dot" + (x.state === "FAULT" ? " bad" : x.lit ? " on" : x.hot ? " warn" : ""));
      left.appendChild(d); left.appendChild(document.createTextNode(x.name));
      r.appendChild(left); r.appendChild(el("span", x.hot && !x.lit ? "hot" : "", x.current + " / " + x.target + " C - " + x.state)); h.appendChild(r);
    });
    var f = $("fans"); clear(f);
    s.fans.forEach(function (x) { row(f, "Fan " + x.name, x.pct + " %"); });

    var a = $("axes"); clear(a);
    s.axes.forEach(function (x) { row(a, "Axis " + x.letter, x.position.toFixed(1) + " mm" + (x.homed ? ", homed" : ", NOT homed"), x.homed ? "" : "hot"); });
    var e = $("endstops"); clear(e);
    s.endstops.forEach(function (x) { var w = el("span", ""); w.appendChild(el("span", "dot" + (x.triggered ? " warn" : ""))); w.appendChild(document.createTextNode(x.axis + (x.triggered ? " pressed" : ""))); e.appendChild(w); });
    if (s.extraError) { var er = el("div", "mute", "Some values could not be read: " + s.extraError); e.appendChild(er); }

    var c = $("camera");
    var n = s.pictures.newest;
    if (!n) { if (shown !== "none") { clear(c); c.appendChild(el("p", "mute", "No pictures yet. They appear when Claude looks at the camera or when periodic pictures are on.")); shown = "none"; } }
    else if (shown !== n.file) {
      clear(c); shown = n.file;
      c.appendChild(el("p", "", "Latest: " + n.time + " - " + n.camera + (n.layer ? " - layer " + n.layer : "") + (n.auto ? " - auto" : "")));
      var img = el("img"); img.src = "img/" + encodeURIComponent(n.file); img.alt = "latest camera picture"; c.appendChild(img);
      var g = el("div", "grid");
      s.pictures.recent.slice(1, 13).forEach(function (p) {
        var fig = el("figure"); var im = el("img"); im.src = "img/" + encodeURIComponent(p.file); im.loading = "lazy"; im.alt = "";
        fig.appendChild(im); fig.appendChild(el("div", "", p.time.slice(11) + (p.layer ? " L" + p.layer : "") + (p.auto ? " auto" : ""))); g.appendChild(fig);
      });
      c.appendChild(g);
      c.appendChild(el("p", "mute", s.pictures.count + " pictures in the folder"));
    }

    var ev = $("events"); clear(ev);
    if (!s.events.length) ev.appendChild(el("li", "mute", "No notices yet."));
    s.events.forEach(function (x) { var li = el("li", "l-" + x.level); li.appendChild(el("b", "", clock(x.t) + " " + x.code)); li.appendChild(document.createTextNode(" - " + x.message)); ev.appendChild(li); });
    var hi = $("hints"); clear(hi);
    s.hints.forEach(function (t) { hi.appendChild(el("li", "", t)); });
  }

  function offline(msg) {
    $("clock").textContent = "no connection to the server (" + msg + ")";
    var b = $("banner"); b.className = "banner l-error"; $("banner-title").textContent = "The cockpit lost the connection to the server"; $("banner-text").textContent = "The MCP server stopped, for example because the chat was closed. This page shows nothing new until it runs again.";
  }
  function tick() {
    fetch("api/cockpit", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(render).catch(function (err) { offline(String(err.message || err)); });
  }
  tick();
  setInterval(tick, 3000);
})();
`;
