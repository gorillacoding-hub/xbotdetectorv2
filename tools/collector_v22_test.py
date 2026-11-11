# Author: gorcoding
# v2.2 collector tests in real headless Chromium against MOCK pages: transports, API-response source, natural pacing.
# The API fixtures follow the assumed shape of X's GraphQL responses (rest_id / legacy / core.user_results ...);
# they are NOT captured from real X, so they validate the parser logic only. Requires: pip install playwright + chromium.
import glob, json, statistics, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
JS = (Path(__file__).resolve().parent.parent/"android/app/src/main/assets/collector.js").read_text()
fails = 0
def check(n, c):
    global fails; print(("PASS " if c else "FAIL ")+n); fails += 0 if c else 1
def user(sn, **kw):
    u = {"__typename":"User","rest_id":"9"+str(abs(hash(sn))%10**8),"core":{"screen_name":sn,"name":sn.title(),"created_at":"Tue Mar 05 10:00:00 +0000 2019"},
         "legacy":{"description":"bio of "+sn,"followers_count":1200,"friends_count":340},"location":{"location":"Delhi, India"},"is_blue_verified":False}
    u.update(kw); return u
def tweet(i, sn, text, reply=False, rt=False, protected=False, quote=None):
    u = user(sn); u["privacy"] = {"protected": protected}
    l = {"full_text": text, "created_at":"Mon Nov 02 09:30:00 +0000 2026","lang":"en","reply_count":2,"retweet_count":3,"favorite_count":9}
    if reply: l["in_reply_to_status_id_str"] = "123"
    if rt: l["retweeted_status_result"] = {"result": {"rest_id":"777","legacy":{"full_text":"orig"}}}
    t = {"rest_id":str(1700000000000000000+i),"legacy":l,"core":{"user_results":{"result":u}},"views":{"count":"1500"}}
    if quote: t["quoted_status_result"] = {"result": tweet(i+500, "quotedperson", "quoted text")}
    return {"itemContent":{"tweet_results":{"result":t}}}
TL = {"data":{"user":{"result":{"timeline":{"instructions":[{"entries":[
    tweet(1,"alice","alice post one"), tweet(2,"alice","alice reply",reply=True), tweet(3,"alice","alice repost",rt=True),
    tweet(4,"bobby","context by bobby"), tweet(5,"alice","alice quoting",quote=True), tweet(6,"alice","hidden",protected=True)]}]}}}}}
FOL = {"data":{"user":{"result":{"timeline":{"instructions":[{"entries":[{"content":{"itemContent":{"user_results":{"result":user("f1")}}}},{"content":{"itemContent":{"user_results":{"result":user("f2")}}}}]}]}}}}}
UBS = {"data":{"user":{"result":user("alice")}}}
exe = (glob.glob("/opt/pw-browsers/chromium-*/chrome-linux64/chrome") or [None])[0]
HTML = "<html><body style='height:30000px'><nav><a data-testid='AppTabBar_Profile_Link'>me</a></nav><div style='height:30000px'></div></body></html>"
def stub(kind):
    return {"both": "window.__msgs=[];window.XBSBridge={postMessage:function(s){window.__msgs.push(['webmsg',JSON.parse(s)])}};window.XBSNative={post:function(s){window.__msgs.push(['native',JSON.parse(s)])}};",
            "native": "window.__msgs=[];window.XBSNative={post:function(s){window.__msgs.push(['native',JSON.parse(s)])}};",
            "none": "window.__msgs=[];"}[kind]
def make(p, kind, api=None, status=200):
    b = p.chromium.launch(executable_path=exe, args=["--no-sandbox"]); ctx = b.new_context()
    def route(r):
        u = r.request.url
        if "/i/api/graphql/" in u:
            op = u.split("/graphql/")[1].split("/")[1].split("?")[0]
            return r.fulfill(status=status, content_type="application/json", body=json.dumps((api or {}).get(op, {})))
        r.fulfill(status=200, content_type="text/html", body=HTML)
    ctx.route("https://x.com/**", route); ctx.add_init_script(stub(kind)+JS); return b, ctx
with sync_playwright() as p:
    # ---- transports
    for kind, want in (("both","webmsg"),("native","native"),("none","none")):
        b, ctx = make(p, kind); pg = ctx.new_page(); pg.goto("https://x.com/search?q=a")
        r = pg.evaluate("__xbs.ping()"); pg.wait_for_timeout(200)
        got = [m[0] for m in pg.evaluate("__msgs") if m[1]["t"] == "ping"]
        check(f"transport {kind}: ping reports '{want}'" + (", message arrives" if want != "none" else ", nothing arrives"), r == want and (got == [want] if want != "none" else got == []))
        b.close()
    # ---- API-response source (timeline), incl. responses that arrive while the app is still 'settling'
    b, ctx = make(p, "native", {"UserTweets": TL})
    pg = ctx.new_page(); pg.goto("https://x.com/alice"); pg.evaluate("fetch('/i/api/graphql/h1/UserTweets?variables=1')"); pg.wait_for_timeout(500)
    check("response arriving BEFORE activation is buffered, nothing sent yet", not [m for m in pg.evaluate("__msgs") if m[1]["t"] == "records"])
    pg.evaluate("__xbs.ctl({active:true,seq:3,mode:{kind:'posts',target:'Alice'},ts:0.1})"); pg.wait_for_timeout(1200)
    msgs = [m[1] for m in pg.evaluate("__msgs")]; recs = [r for m in msgs if m["t"] == "records" for r in m["records"]]
    check("posts step from API data: own posts only (repost, protected, other author, quoted inner tweet skipped)", sorted(r["text"] for r in recs) == ["alice post one","alice quoting","alice reply"])
    check("reply kind comes from in_reply_to (reliable)", {r["text"]: r["kind"] for r in recs}["alice reply"] == "comment")
    check("record fields: ts ISO, metrics, views, lang, seq", all(r["ts"].startswith("2026-11-02T09:30") and r["likes"] == 9 and r["views"] == 1500 and r["lang"] == "en" for r in recs) and all(m["seq"] == 3 for m in msgs if m["t"] == "records"))
    pr = [m for m in msgs if m["t"] == "profiles"]
    check("author profile (age, followers, location, bio) sent alongside posts", pr and pr[0]["profiles"][0]["followers"] == 1200 and pr[0]["profiles"][0]["location"] == "Delhi, India" and pr[0]["profiles"][0]["created_iso"].startswith("2019-03-05"))
    pg.evaluate("__xbs.ctl({seq:4,mode:{kind:'replies',target:'alice'}})"); pg.wait_for_timeout(300)   # wrong page for 'replies' (path /alice) => nothing
    check("step re-scoped to a different page => nothing more sent", len([1 for m in pg.evaluate("__msgs") if m[1]["t"] == "records"]) == len([1 for m in msgs if m["t"] == "records"]))
    b.close()
    # ---- API-response source (search, followers, profile) and 429
    b, ctx = make(p, "webmsg" if False else "both", {"SearchTimeline": TL, "Followers": FOL, "UserByScreenName": UBS})
    pg = ctx.new_page(); pg.goto("https://x.com/search?q=europe"); pg.evaluate("__xbs.ctl({active:true,seq:1,mode:{kind:'search',target:''},ts:0.1})")
    pg.evaluate("fetch('/i/api/graphql/h2/SearchTimeline?variables=1')"); pg.wait_for_timeout(1200)
    recs = [r["username"] for m in pg.evaluate("__msgs") if m[1]["t"] == "records" for r in m[1]["records"]]
    check("search step: authors of all results (not only one user)", sorted(set(recs)) == ["alice","bobby"])
    pg2 = ctx.new_page(); pg2.goto("https://x.com/alice/followers"); pg2.evaluate("__xbs.ctl({active:true,seq:2,mode:{kind:'followers',target:'alice'},ts:0.1})")
    pg2.evaluate("fetch('/i/api/graphql/h3/Followers?variables=1')"); pg2.wait_for_timeout(1000)
    us = [u for m in pg2.evaluate("__msgs") if m[1]["t"] == "relations" for u in m[1]["users"]]
    check("followers step from API data incl. location + follower counts", [u["username"] for u in us] == ["f1","f2"] and us[0]["location"] == "Delhi, India" and us[0]["followers"] == 1200)
    pg3 = ctx.new_page(); pg3.goto("https://x.com/alice"); pg3.evaluate("__xbs.ctl({active:true,seq:5,mode:{kind:'profile',target:'alice'},ts:0.1})")
    pg3.evaluate("fetch('/i/api/graphql/h4/UserByScreenName?variables=1')"); pg3.wait_for_timeout(1500)
    pf = [m[1] for m in pg3.evaluate("__msgs") if m[1]["t"] == "profile"]
    check("profile step from API data: exactly one profile message", len(pf) == 1 and pf[0]["profile"]["followers"] == 1200 and pf[0]["profile"]["following"] == 340)
    b.close()
    b, ctx = make(p, "both", {}, status=429)
    pg = ctx.new_page(); pg.goto("https://x.com/search?q=a"); pg.evaluate("fetch('/i/api/graphql/h9/SearchTimeline')"); pg.wait_for_timeout(5000)
    st = [m[1] for m in pg.evaluate("__msgs") if m[1]["t"] == "state"]
    check("HTTP 429 from X is reported as a rate_limit challenge (collection will pause)", st and st[-1]["challenge"] == "rate_limit")
    b.close()
    # ---- natural pacing: variable distances, speeds and pauses (time compressed 5x for the test)
    b, ctx = make(p, "both"); pg = ctx.new_page(); pg.goto("https://x.com/search?q=a")
    pg.evaluate("window.__sc=[];var o=window.scrollBy.bind(window);window.scrollBy=function(a,b){window.__sc.push([performance.now(),(a&&typeof a==='object')?a.top:b]);return o.apply(window,arguments)}")
    pg.evaluate("__xbs.ctl({active:true,autoscroll:true,seq:1,mode:{kind:'search',target:''},ts:0.2})"); pg.wait_for_timeout(24000)
    sc = [x for x in pg.evaluate("__sc") if x[1] is not None]; ds = [d for _, d in sc]; ts = [t for t, _ in sc]
    allg = [b-a for a, b in zip(ts, ts[1:])]; print("   scroll calls:", len(sc), "| gaps>200ms (ms):", [round(g) for g in allg if g > 200][:25])
    big = [t for t, g in zip(ts[1:], [b-a for a, b in zip(ts, ts[1:])]) if g > 200]   # gesture boundaries (reading pauses)
    gaps = [b-a for a, b in zip(big, big[1:])]
    check("scrolling happens in many small varied steps", len(sc) > 40 and len(set(ds)) > 20)
    check("pauses between gestures vary (not a fixed interval)", len(gaps) >= 5 and statistics.pstdev(gaps)/statistics.mean(gaps) > 0.25)
    check("step sizes vary and are not constant", statistics.pstdev([abs(d) for d in ds]) > 5)
    pg.evaluate("__xbs.ctl({active:false})"); n0 = len(pg.evaluate("__sc")); pg.wait_for_timeout(1500)
    check("inactive/paused => no scrolling at all", len(pg.evaluate("__sc")) <= n0 + 2)   # pause stops even an in-flight gesture
    b.close()
print("FAILURES:", fails); sys.exit(1 if fails else 0)
