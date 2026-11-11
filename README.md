# XBotDetector (XBotScope) v2.2.0 — by gorcoding
Local dashboard (Termux + Flask) that scores X accounts as **human / machine / foreign-service**, fed by **your own logged-in x.com session** in a small Android WebView app.

```
Android app "XBotScope Browser" (WebView = X only)  ──records, 127.0.0.1 only, pairing token──▶  Termux: Flask backend ─▶ data/<user>/ ─▶ analyze()
                                                                                                         ▲
Your normal browser  ──────────────  http://127.0.0.1:8080  (the dashboard)  ─────────────────────────────┘
```

## 1. Termux
```
pkg install -y unzip && unzip XBotDetector-v2.2.zip && cd XBotDetector
bash install.sh && bash run.sh        # dashboard: http://127.0.0.1:8080
```
Upgrade: unzip over the old folder; keep `data/` and `settings.json`.

## 2. Browser app (`android/`)
- **GitHub Actions (phone only):** upload the whole project to a GitHub repo → *Actions → Build APK → Run workflow* → download `xbotscope-browser-debug` → install. If it fails, send me the failed step's log.
- **Android Studio:** open `android/` → Build APK.
Needs Android 8+ and an up-to-date *Android System WebView*.

## 3. First run — do these checks in order
1. Dashboard (browser) → *Pair / launch → Show pairing (2 min)* → tap **Pair this app** (opens the app and pairs it). Dashboard must say **Browser: connected**.
2. In the app log in to X manually. Press **Test**: you want *"page script: webmsg (or native) · message reached app: YES · backend: connected"*.
   - `NO_SCRIPT` → the page script did not load (update WebView, reload X). `NO` → the message path is failing (tell me the exact text).
3. **Keep X alive while you use the dashboard:** Android pauses hidden pages. Use **split-screen** (X app + browser) or press **Float** in the app (also automatic when you leave it while collecting).
4. Dashboard → **Auto plan**: profiles + limits (posts 100, replies 50, followers/following 0 = skip) → **Start plan**. Each step switches the page by itself when its limit is reached, then the next profile. The **Pipeline** row shows: page→app messages → sent → accepted. Finished profiles are analysed automatically (see *Saved profiles*).
5. Manual single search, Saved-profiles manager (browse/export/delete), optional AI second opinion: as in 2.1 (see CHANGELOG).

### If nothing is collected, the dashboard now tells you where it stops
| Pipeline / Page row | Meaning |
|---|---|
| "app has received NOTHING from the X page" | script missing or message path broken → press **Test** |
| messages > 0 but sent 0 | collection not running / still settling / paused |
| sent > 0 but accepted 0 | look at *rejected*: other author/kind (wrong page for the step), stale (step changed), invalid |
| right page = no | the WebView is not on the page the step expects |
| 0 posts, 0 users, API batches 0 | not logged in / loading / X changed |

## 4. Pacing & limits
Scrolling is deliberately natural and slow: variable distance and speed, multi-part gestures, drifting pace, reading pauses (median ≈ 3.8 s, sometimes much longer), occasional scroll-back, jittered timers. This keeps load on X gentle; it is **not** a way to hide automation — X may still challenge or limit the account. On any CAPTCHA/verification/lock or HTTP 429 everything **pauses** and only an explicit **Resume** continues. Nothing is bypassed.

## 5. Data sources
(1) visible page, (2) responses X's page already received (read-only; no requests are made, no headers or cookies touched). Both feed the same validated pipeline; duplicates are dropped.

## 6. Privacy
Never collected: passwords, codes, cookies, tokens, DMs, protected accounts, reposts. Backend binds 127.0.0.1; Host check + `X-XBS` header; bridge token; only INTERNET (+ picture-in-picture, no extra permissions); cleartext only to 127.0.0.1; page script injected for `https://x.com` only. The fallback native bridge is host-checked and accepts only validated records. Optional AI sends numbers only unless you allow samples (see Settings).

## 7. Tests (`tools/`)
`selftest.py`, `selftest_plan.py` (backend), `collector_test.py`, `collector_modes_test.py`, `collector_v22_test.py` (page script in headless Chromium vs mock pages; `pip install playwright`), `audit.py`.

## 8. Known limitations — read this
- **Not run on a real phone or real x.com.** The Kotlin app has never been compiled (no Android SDK here). The API-response parser follows the assumed shape of X's responses (fixtures are mine, not captured); if X's shape differs the DOM source still works, and vice-versa — the Pipeline row shows which.
- X may change markup/APIs, challenge, limit or suspend the account; its Terms restrict automated collection. Use an account you can afford to lose.
- Floating (PiP) window is small; split-screen is more reliable on some phones.
- Followers/following need X to load them; protected profiles are skipped (steps time out after 25–60 s).

## 9. Troubleshooting
| Problem | Fix |
|---|---|
| Browser *disconnected* | `bash run.sh`, re-pair, same port, exempt the app from battery optimisation |
| Collection stops when I open the dashboard | use split-screen or **Float** |
| Test says NO_SCRIPT / NO | update *Android System WebView*; send me the toast text |
| "WebView too old" | update WebView / Chrome |
| X login loops | username+password (non-X sites are blocked), solve prompts, retry later |
| 403 on dashboard | use `http://127.0.0.1:8080` |
