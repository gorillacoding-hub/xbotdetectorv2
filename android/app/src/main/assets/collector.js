// Author: gorcoding
// XBotScope page collector (v2.2). Injected at document start for https://x.com ONLY.
// Two PASSIVE data sources for the CURRENT step set by the app (search | posts | replies | followers | following | profile):
//   1) the visible page (DOM), 2) the responses X's own page already receives (read-only; no extra requests are made).
// It never touches credentials, cookies, storage or forms, never reads request headers, never clicks anything.
// Scrolling uses natural, randomised pacing (variable distance, speed and reading pauses) to stay gentle on X.
(function () {
  "use strict";
  if (window.__xbs || location.origin !== "https://x.com") return;
  var S = { active: false, autoscroll: false, mode: { kind: "search", target: "" }, seq: 0, seen: new Set(), pdone: new Set(),
            end: false, stuck: 0, lastH: 0, pSeen: 0, pSent: -1, via: "", rl: 0, netBuf: [], newSince: 0, gliding: false, pace: 1, ts: 1 };

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function gauss() { var u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function lc(s) { return String(s || "").toLowerCase(); }
  function T(ms) { return ms * S.ts; }

  // ---- transport: WebMessage (origin-restricted) first, native bridge as fallback
  function send(o) {
    o.seq = S.seq; var s = JSON.stringify(o);
    try { if (typeof XBSBridge !== "undefined") { XBSBridge.postMessage(s); S.via = "webmsg"; return; } } catch (e) {}
    try { if (typeof XBSNative !== "undefined") { XBSNative.post(s); S.via = "native"; return; } } catch (e) {}
    S.via = "none";
  }
  function num(s) {
    if (s == null) return null;
    var m = String(s).replace(/,/g, "").trim().match(/^([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1));
  }
  function metric(a, id) { var el = a.querySelector('[data-testid="' + id + '"]'); if (!el) return null; var t = (el.innerText || "").trim(); return t === "" ? 0 : num(t); }
  function tweets() { var n = document.querySelectorAll('article[data-testid="tweet"]'); return n.length ? n : document.querySelectorAll('article[role="article"]'); }
  function cells() { return document.querySelectorAll('[data-testid="UserCell"]'); }
  function path() { return lc(location.pathname).replace(/\/+$/, ""); }
  function authorOf(a) {
    var t = a && a.querySelector("time"), l = t && t.closest("a");
    var m = l && (l.getAttribute("href") || "").match(/^\/(\w{1,15})\/status\/\d+/);
    return m ? m[1] : null;
  }
  function inScope() {
    var k = S.mode.kind, p = path(), t = "/" + lc(S.mode.target);
    if (k === "search") return location.pathname.indexOf("/search") === 0;
    if (k === "posts" || k === "profile") return p === t;
    if (k === "replies") return p === t + "/with_replies";
    if (k === "followers") return p === t + "/followers";
    if (k === "following") return p === t + "/following";
    return false;
  }
  function pageKind() {
    if (location.pathname.indexOf("/search") === 0) return "search";
    return /^\/\w{1,15}\/?$/.test(location.pathname) ? "profile" : "other";
  }

  // ---- challenge / security-state detection (never bypassed: only reported; the app pauses and the user solves it)
  function challenge() {
    if (Date.now() - S.rl < 45000) return "rate_limit";                        // X answered 429 to its own page
    if (location.pathname.indexOf("/account/access") === 0) return "captcha";
    if (document.querySelector('iframe[src*="arkoselabs"],iframe[src*="funcaptcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')) return "captcha";
    if (tweets().length || cells().length) return null;
    var txt = ((document.body && document.body.innerText) || "").slice(0, 3000).toLowerCase();
    if (/verify you are human|are you a robot|confirm you.re (a )?human|complete the (captcha|challenge)/.test(txt)) return "captcha";
    if (/confirm your identity|verify your identity|suspicious login|unusual login activity/.test(txt)) return "verification";
    if (/rate limit exceeded|you.re rate limited|exceeded the rate limit/.test(txt)) return "rate_limit";
    if (/account is (temporarily )?locked|account (has been )?suspended|temporarily restricted/.test(txt)) return "locked";
    return null;
  }
  function authState() {
    var p = location.pathname;
    if (p.indexOf("/i/flow/login") === 0 || p === "/login" || p.indexOf("/i/flow/signup") === 0) return "logged_out";
    if (document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="AppTabBar_Profile_Link"]')) return "logged_in";
    return "unknown";
  }
  function reportState() {
    send({ t: "state", auth: authState(), page: pageKind(), challenge: challenge(), end: S.end, via: S.via,
           diag: { articles: tweets().length, cells: cells().length, seen: S.seen.size, scope: inScope(), path: location.pathname.slice(0, 60), net: S.netBuf.length } });
  }

  // =====================  SOURCE 1: DOM  =====================
  function extract(a, replyCtx) {
    var t = a.querySelector("time"); if (!t) return null;
    var link = t.closest("a"); if (!link) return null;
    var m = (link.getAttribute("href") || "").match(/^\/(\w{1,15})\/status\/(\d+)/); if (!m) return null;
    var id = m[2]; if (S.seen.has(id)) return null;
    S.seen.add(id);
    if (a.querySelector('[data-testid="icon-lock"]')) return null;                       // protected account: skip
    var sc = a.querySelector('[data-testid="socialContext"]');
    if (sc && /repost|retweet/i.test(sc.innerText || "")) return null;                   // reposts belong to the original author: skip
    var txt = a.querySelector('[data-testid="tweetText"]'), nm = a.querySelector('[data-testid="User-Name"]');
    var av = a.querySelector('[data-testid="Tweet-User-Avatar"] img'), views = a.querySelector('a[href$="/analytics"]');
    var isReply = /^\s*Replying to\b/m.test((a.innerText || "").slice(0, 400));
    if (!isReply && replyCtx) {
      var cell = a.closest('[data-testid="cellInnerDiv"]'), prev = cell && cell.previousElementSibling;
      var pa = prev && authorOf(prev.querySelector('article[data-testid="tweet"]'));
      if (pa && lc(pa) !== lc(m[1])) isReply = true;
    }
    return { id: id, username: m[1], name: nm ? ((nm.innerText || "").split("\n")[0] || "").slice(0, 80) : "",
      text: txt ? txt.innerText : "", ts: t.getAttribute("datetime"), kind: isReply ? "comment" : "post",
      verified: !!a.querySelector('[data-testid="icon-verified"]'), avatar: av ? av.src : "", lang: txt ? txt.getAttribute("lang") : null,
      replies: metric(a, "reply"), reposts: metric(a, "retweet"), likes: metric(a, "like"), views: views ? num(views.innerText) : null };
  }
  function emit(out) { S.newSince += out.length; for (var i = 0; i < out.length; i += 50) send({ t: "records", records: out.slice(i, i + 50) }); }
  function scanTweets() {
    var k = S.mode.kind, target = lc(S.mode.target), out = [];
    tweets().forEach(function (a) {
      if (a.parentElement && a.parentElement.closest("article")) return;
      if (k !== "search") { var au = authorOf(a); if (!au || lc(au) !== target) return; }
      var r = extract(a, k === "replies"); if (r) out.push(r);
    });
    if (out.length) emit(out);
  }
  function scanUsers() {
    var out = [];
    cells().forEach(function (c) {
      var a = c.querySelector('a[href^="/"][role="link"]'); if (!a) return;
      var m = (a.getAttribute("href") || "").match(/^\/(\w{1,15})$/); if (!m) return;
      var key = "u:" + lc(m[1]); if (S.seen.has(key)) return; S.seen.add(key);
      if (c.querySelector('[data-testid="icon-lock"]')) return;
      var lines = (c.innerText || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var rest = lines.slice(1).filter(function (l) { return l.charAt(0) !== "@" && !/^(Follow|Following|Follows you|Pending|Unfollow|Click to Follow.*)$/i.test(l); });
      out.push({ username: m[1], name: (lines[0] || "").slice(0, 80), bio: rest.join(" ").slice(0, 500) });
    });
    for (var i = 0; i < out.length; i += 50) { S.newSince += 1; send({ t: "relations", kind: S.mode.kind, users: out.slice(i, i + 50) }); }
  }
  function readProfile(force) {
    if (S.pSent === S.seq && !force) return;
    var un = document.querySelector('[data-testid="UserName"]');
    if (!un || un.querySelector('[data-testid="icon-lock"]')) return;
    var hasJoin = !!document.querySelector('[data-testid="UserJoinDate"]');
    if (!S.pSeen) S.pSeen = Date.now();
    if (!force && !hasJoin && Date.now() - S.pSeen < 6000) return;
    function q(sel) { var e = document.querySelector(sel); return e ? (e.innerText || "") : ""; }
    function fol(suffix) { var a = document.querySelector('a[href$="/' + suffix + '"]'); return a ? num(a.innerText) : null; }
    var f = fol("verified_followers"); if (f == null) f = fol("followers");
    var m = location.pathname.match(/^\/(\w{1,15})\/?$/); if (!m) return;
    S.pSent = S.seq;
    send({ t: "profile", profile: { username: m[1], name: ((un.innerText || "").split("\n")[0] || "").slice(0, 80),
      bio: q('[data-testid="UserDescription"]'), location: q('[data-testid="UserLocation"]'),
      joined: q('[data-testid="UserJoinDate"]'), followers: f, following: fol("following") } });
  }
  function scan() {
    if (!S.active || !inScope() || challenge()) return;
    var k = S.mode.kind;
    if (k === "followers" || k === "following") scanUsers();
    else if (k === "profile") readProfile(false);
    else scanTweets();
  }

  // =====================  SOURCE 2: responses X's page already received (read-only)  =====================
  var GQL = /\/i\/api\/graphql\/[^\/]+\/(\w+)/;
  function netIn(url, status, text) {
    var m = GQL.exec(url || ""); if (!m) return;
    if (status === 429) { S.rl = Date.now(); return; }
    if (status < 200 || status >= 300 || !text || text.length > 6000000) return;
    var j; try { j = JSON.parse(text); } catch (e) { return; }
    var e = { op: m[1], j: j };
    S.netBuf.push(e); if (S.netBuf.length > 25) S.netBuf.shift();   // responses can arrive while the app is still "settling" - keep them
    if (S.active) harvest(e);
  }
  (function hook() {
    try {
      var of = window.fetch;
      if (typeof of === "function") window.fetch = function () {
        var a = arguments, p = of.apply(this, a);
        try {
          var u = (typeof a[0] === "string") ? a[0] : ((a[0] && a[0].url) || "");
          if (GQL.test(u)) p.then(function (r) { try { r.clone().text().then(function (t) { netIn(u, r.status, t); }).catch(function () {}); } catch (e) {} }).catch(function () {});
        } catch (e) {}
        return p;
      };
      var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (X) {
        var oo = X.open, os = X.send;
        X.open = function (m, u) { try { this.__xu = String(u); } catch (e) {} return oo.apply(this, arguments); };
        X.send = function () {
          try { var x = this; if (x.__xu && GQL.test(x.__xu)) x.addEventListener("load", function () { try { netIn(x.__xu, x.status, (x.responseType === "" || x.responseType === "text") ? x.responseText : ""); } catch (e) {} }); } catch (e) {}
          return os.apply(this, arguments);
        };
      }
    } catch (e) {}
  })();
  function walk(n, out, d) {
    if (!n || typeof n !== "object" || d > 40) return;
    if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walk(n[i], out, d + 1); return; }
    if (typeof n.rest_id === "string" && n.legacy && typeof n.legacy.full_text === "string") out.tweets.push(n);
    else if (n.__typename === "User" && typeof n.rest_id === "string") out.users.push(n);
    for (var k in n) { if (k === "retweeted_status_result" || k === "quoted_status_result" || k === "card") continue; walk(n[k], out, d + 1); }
  }
  function sn(u) { return (u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name) || ""; }
  function nameOf(u) { return ((u.core && u.core.name) || (u.legacy && u.legacy.name) || "").slice(0, 80); }
  function prot(u) { return !!((u.privacy && u.privacy.protected) || (u.legacy && u.legacy.protected)); }
  function desc(u) { return ((u.legacy && u.legacy.description) || (u.profile_bio && u.profile_bio.description) || "").slice(0, 500); }
  function loc(u) { return ((u.location && u.location.location) || (u.legacy && u.legacy.location) || "").slice(0, 100); }
  function iso(s) { var d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); }
  function unesc(t) { return String(t).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
  function profOf(u) {
    var l = u.legacy || {};
    return { username: sn(u), name: nameOf(u), bio: desc(u), location: loc(u), created_iso: iso((u.core && u.core.created_at) || l.created_at),
             followers: typeof l.followers_count === "number" ? l.followers_count : null, following: typeof l.friends_count === "number" ? l.friends_count : null };
  }
  function tweetRec(t) {
    var u = t.core && t.core.user_results && t.core.user_results.result; if (!u) return null;
    var name = sn(u); if (!/^\w{1,15}$/.test(name) || prot(u)) return null;
    var l = t.legacy; if (l.retweeted_status_result) return null;
    var nt = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    var ts = iso(l.created_at); if (!ts) return null;
    var av = (u.avatar && u.avatar.image_url) || (u.legacy && u.legacy.profile_image_url_https) || "";
    return { id: t.rest_id, username: name, name: nameOf(u), text: unesc((nt && nt.text) || l.full_text), ts: ts,
      kind: l.in_reply_to_status_id_str ? "comment" : "post", verified: !!(u.is_blue_verified || (u.legacy && u.legacy.verified)),
      avatar: av, lang: l.lang || null, replies: l.reply_count, reposts: l.retweet_count, likes: l.favorite_count,
      views: t.views && t.views.count ? parseInt(t.views.count, 10) : null, _u: u };
  }
  function harvest(e) {
    if (!inScope()) return;
    var k = S.mode.kind, target = lc(S.mode.target);
    if (k === "followers" && !/Followers/.test(e.op)) return;
    if (k === "following" && !/Following/.test(e.op)) return;
    var o = { tweets: [], users: [] }; walk(e.j, o, 0);
    if (k === "profile") {
      if (S.pSent === S.seq) return;
      for (var i = 0; i < o.users.length; i++) {
        var u = o.users[i]; if (lc(sn(u)) !== target || prot(u)) continue;
        var p = profOf(u); if (p.followers == null && !p.created_iso) continue;
        S.pSent = S.seq; send({ t: "profile", profile: p }); return;
      }
      return;
    }
    if (k === "followers" || k === "following") {
      var us = [];
      o.users.forEach(function (u) {
        var n = sn(u), key = "u:" + lc(n); if (!/^\w{1,15}$/.test(n) || S.seen.has(key) || prot(u)) return; S.seen.add(key);
        var l = u.legacy || {}; us.push({ username: n, name: nameOf(u), bio: desc(u), location: loc(u), followers: typeof l.followers_count === "number" ? l.followers_count : null });
      });
      for (var j = 0; j < us.length; j += 50) { S.newSince += 1; send({ t: "relations", kind: k, users: us.slice(j, j + 50) }); }
      return;
    }
    var out = [], profs = [];
    o.tweets.forEach(function (t) {
      var r = tweetRec(t); if (!r || S.seen.has(r.id)) return;
      if (k !== "search" && lc(r.username) !== target) return;
      S.seen.add(r.id);
      if (!S.pdone.has(lc(r.username))) { S.pdone.add(lc(r.username)); var p = profOf(r._u); if (p.followers != null || p.created_iso) profs.push(p); }
      delete r._u; out.push(r);
    });
    if (profs.length) send({ t: "profiles", profiles: profs.slice(0, 50) });
    if (out.length) emit(out);
  }
  function drain() { S.netBuf.slice().forEach(function (e) { try { harvest(e); } catch (x) {} }); }

  // =====================  natural scrolling  =====================
  function easeIO(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function glide(dist, dur, done) {
    var start = performance.now(), last = 0; S.gliding = true;
    function frame(now) {
      if (!S.active || !S.autoscroll) { S.gliding = false; return; }          // paused/stopped: stop immediately
      var t = Math.min(1, (now - start) / dur), want = Math.round(dist * easeIO(t)), d = want - last;
      if (d !== 0) { window.scrollBy(0, d); last = want; }
      if (t < 1) requestAnimationFrame(frame); else { S.gliding = false; if (done) done(); }
    }
    requestAnimationFrame(frame);
  }
  function readPause() {   // log-normal reading time, median ~3.8 s, occasional long look
    var ms = Math.exp(Math.log(3800) + 0.5 * gauss());
    if (Math.random() < 0.07) ms += rnd(6000, 16000);
    return Math.min(Math.max(ms, 1400), 24000) + Math.random();
  }
  function gesture() {
    var vh = Math.max(window.innerHeight, 300);
    S.pace = Math.min(1.35, Math.max(0.75, S.pace + gauss() * 0.06));            // slowly drifting speed
    var total = Math.max(240, vh * rnd(0.5, 0.95) * S.pace), parts = 1 + Math.floor(Math.random() * 3), left = total, i = 0;
    (function next() {
      if (!S.active || !S.autoscroll) return;
      if (i >= parts) {
        if (Math.random() < 0.08) setTimeout(function () { glide(-rnd(70, 260), T(rnd(380, 800)), null); }, T(rnd(300, 900)));   // small scroll back up
        return;
      }
      var d = (i === parts - 1) ? left : left * rnd(0.3, 0.7); left -= d; i++;
      var dur = Math.min(1500, Math.max(280, rnd(420, 1100) * Math.sqrt(Math.max(d, 80) / (vh * 0.6)))) + Math.random() * 37;
      glide(d, T(dur), function () { setTimeout(next, T(rnd(120, 480) + Math.random() * 29)); });
    })();
  }
  function loop() {
    var wait = rnd(900, 1700);
    try {
      if (S.active && S.mode.kind === "profile") scan();
      else if (S.active && S.autoscroll && inScope() && !S.end && !S.gliding && !challenge()) {
        var h = document.documentElement.scrollHeight, bottom = window.innerHeight + window.scrollY >= h - 8;
        if (S.newSince === 0 && h === S.lastH && bottom) S.stuck++; else S.stuck = 0;
        S.lastH = h;
        if (S.stuck >= 6) { S.end = true; S.autoscroll = false; reportState(); }
        else { wait = S.newSince > 0 ? readPause() * (0.8 + 0.08 * Math.min(S.newSince, 8)) : rnd(1500, 3200); S.newSince = 0; gesture(); }
      }
    } catch (e) {}
    setTimeout(loop, T(wait));
  }
  function stateLoop() { try { reportState(); } catch (e) {} setTimeout(stateLoop, T(rnd(2500, 3700))); }

  function ctl(o) {
    var changed = false;
    if (typeof o.ts === "number" && o.ts > 0) S.ts = o.ts;          // test hook only (speeds up timers); the app never sends it
    if (typeof o.seq === "number" && o.seq !== S.seq) { S.seq = o.seq; changed = true; }
    if (o.mode && (o.mode.kind !== S.mode.kind || lc(o.mode.target) !== lc(S.mode.target))) { S.mode = { kind: o.mode.kind, target: o.mode.target || "" }; changed = true; }
    if (o.reset || changed) { S.seen = new Set(); S.pdone = new Set(); S.end = false; S.stuck = 0; S.lastH = 0; S.pSeen = 0; S.pSent = -1; S.newSince = 1; }
    var was = S.active;
    if (typeof o.active === "boolean") S.active = o.active;
    if (typeof o.autoscroll === "boolean") S.autoscroll = o.autoscroll;
    if (S.active && (!was || changed || o.reset)) { setTimeout(function () { drain(); scan(); }, T(rnd(250, 500))); }
  }

  window.__xbs = { ctl: ctl, profile: function () { S.pSeen = Date.now(); readProfile(true); }, ping: function () { send({ t: "ping" }); return S.via || "unknown"; } };
  var deb = null;
  function arm() {
    if (!document.documentElement) return setTimeout(arm, 50);
    new MutationObserver(function () { clearTimeout(deb); deb = setTimeout(scan, T(rnd(500, 900))); }).observe(document.documentElement, { childList: true, subtree: true });
  }
  arm(); setTimeout(stateLoop, 800); setTimeout(loop, T(rnd(1200, 2500)));
})();
