# Changelog — by gorcoding

## 2.2.0
**Why:** v2.1 scrolled and switched pages (by timeout) but no post ever reached the backend. The break was between the X page and the app, so this release makes that path redundant and visible.

**Fixed / added**
- **Layout restored:** dashboard in your normal browser at `http://127.0.0.1:8080`; the Android app is a WebView for **X only** (the in-app dashboard of 2.1 is gone).
- **Two page→app transports:** origin-restricted WebMessage first, native bridge as fallback (host-checked). If the document-start injection does not run, the script is injected again when the page finishes loading.
- **Second data source:** the script also reads the responses X's own page already receives (read-only, no extra requests, no headers touched). Gives exact timestamps, reply flags, metrics, **account age, followers, location and bio of every author seen**, plus follower/following lists with locations — and it no longer depends on DOM selectors. Responses that arrive while the app is "settling" are buffered, not lost.
- **Rate limit awareness:** an HTTP 429 to X's page pauses collection (needs explicit Resume).
- **Natural pacing:** variable scroll distance, eased speed with sub-pixel/ms jitter, multi-part gestures, drifting pace, log-normal reading pauses (median ≈ 3.8 s, occasional long looks), occasional small scroll-back, random timer jitter everywhere. Nothing fixed-interval.
- **Diagnostics:** app **Test** button (script present? which transport? message arrived?), status line with counters, dashboard *Page* and *Pipeline* rows and a warning when the app has received nothing from the page.
- **Float** button / auto-float: picture-in-picture keeps the X page alive while you use the dashboard in your browser (Android pauses hidden pages). Split-screen works too.

## 2.1.0
Auto plan with per-step limits and automatic page switching, profile-only analysis, saved-profiles manager, optional AI second opinion, engine fixes (single-agenda false positive, confidence, engagement), canonical usernames, pairing window, secret masking.

## 2.1.0
**Added**
- **Auto plan** (dashboard + `core/bridge.py`): per profile *header → posts → replies → followers → following*, then the next profile / search. Each step has its own limit (e.g. replies 50); when it is reached — or the end of results, or 60 s without progress — the browser **switches to the next page by itself**. Settle pause (6–11 s) after each switch, human-paced scrolling, challenges still pause everything and need an explicit Resume. Skip-step button.
- **Profile-only analysis**: run a plan with just a profile (header + posts/replies limits); the engine runs automatically when its steps finish. Also works with several profiles / x.com links at once.
- **Saved profiles manager**: browse, filter, open, export (JSON), delete selected, delete everything (typed confirmation); refuses to delete a profile an active plan is using.
- **Optional AI second opinion** (off by default): Anthropic or any OpenAI-compatible endpoint (incl. local Ollama). Needs explicit consent in Settings; default sends numbers only (no post text, bio or identity). Output is shown separately and never changes the scores. Post text is treated as untrusted (prompt-injection guard).
- **In-app dashboard**: the Android app now shows the dashboard on top of the X view, so you never have to leave it (leaving let Android throttle the X page and stop collection). Screen is kept awake while collecting.
- **Diagnostics**: dashboard + app status show posts/users visible on the page, whether it is the right page for the step, filtered off-target counts, and warn when nothing is visible.
- Engine: `confidence` (data coverage) and `engagement` medians in the output.

**Changed / fixed**
- `single-agenda content` no longer fires on a handful of topic words (needs ≥ 15 topic hits).
- Usernames are matched case-insensitively to one data folder (`Alice` = `alice`).
- Pairing token is only shown for 2 minutes after pressing *Show pairing*; API keys / bearer / cookies are never sent back to the browser.
- Records/relations/profile messages carry a step sequence number; stale messages from the previous page are discarded.
- Workflow: `--stacktrace` for readable build failures.

## 2.0.0
**Added**
- Authenticated X collection through the main site (https://x.com) in a dedicated Android WebView app (`android/`). Manual login, persistent isolated session, CAPTCHA/verification shown to the user.
- Local bridge (`core/bridge.py`): validated records (post id/url/text/author/name/timestamp/metrics/public profile fields) → existing storage (`data/<user>/`) → existing `analyze()` engine.
- Dashboard card: query, tab (Top/Latest), max posts, auto-scroll (off by default), start / pause / resume / stop / clear session, live status (browser connection, X login state, collection state, posts, accounts found/analysed/awaiting, errors, last record), discovered-accounts table, coordination clusters, pairing.
- Challenge handling: CAPTCHA / verification / rate-limit / lock detection pauses collection; only an explicit Resume continues. Nothing is bypassed or automated.
- Assessment labels (automated / suspicious / unusual activity / no strong indicators) as a presentation layer on top of the unchanged V1 scores; never from one indicator.
- Cross-account coordination clusters (same/near-same text from different accounts).
- Optional, slow, user-triggered profile enrichment (bio, location, join date, follower counts).
- Hardening: Host check (DNS-rebinding), `X-XBS` header on dashboard POSTs, token-protected bridge routes, 512 KB request cap, loopback-only bind.
- `tools/selftest.py`, `tools/collector_test.py`, `tools/audit.py`; GitHub Actions workflow to build the APK without a PC.

**Unchanged (byte-identical to V1):** `core/analyze.py` (scoring), `core/runner.py`, `core/providers.py`, `core/dorks.py`, `core/http.py`, `core/store.py`, `core/job.py`, data layout, live mode, username fetch.

**Changed**
- Nitter is deprecated (kept selectable, usually offline). `api` is the recommended username-fetch provider.
- `static/index.html`: V2 card + `X-XBS` header. `app.py`: bridge routes + guards.

## 1.0.0
Initial release: username fetch (nitter/api), analysis, dorks, dashboard.
