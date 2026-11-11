// Author: gorcoding
package com.gorcoding.xbotscope

import android.app.Activity
import android.app.AlertDialog
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * XBotScope Browser (v2.2): a WebView that is ONLY for https://x.com. The dashboard stays in your normal browser
 * at http://127.0.0.1:8080 (Termux). The user logs in manually; cookies are never read, only deleted.
 * The page script (assets/collector.js) reports PUBLIC fields for the current step; this app forwards validated
 * records to the local backend using a local pairing token.
 */
class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var toolbar: View
    private lateinit var web: WebView
    private lateinit var statusView: TextView
    private lateinit var client: BridgeClient
    private lateinit var collectorJs: String
    private var ready = false

    // state mirrored from the backend / page
    private var backendState = "idle"
    private var query = ""
    private var autoscroll = false
    private var connected = false
    private var hold = false
    private var seq = 0
    private var modeKind = "search"
    private var modeTarget = ""
    private var auth = "unknown"
    private var page = "other"
    private var pageChallenge: String? = null
    private var pageSeq = -1
    private var endOfResults = false
    private var diag: JSONObject? = null
    private val enrichQueue = ArrayDeque<String>()
    private var enriching = false

    // pipeline counters (shown in the status line and on the dashboard so a break is visible)
    private var msgs = 0
    private var posted = 0
    private var accepted = 0
    private var via = ""

    private val beat = object : Runnable {
        override fun run() { heartbeat(); ui.postDelayed(this, 2000) }
    }

    /** Fallback transport (used only if the origin-restricted WebMessage channel is unavailable). Validated by main-page host. */
    inner class NativeBridge {
        @JavascriptInterface
        fun post(data: String) {
            ui.post { if (Uri.parse(web.url ?: "").host == "x.com") onPageMessage(data, "native") }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        client = BridgeClient(getSharedPreferences("xbs", MODE_PRIVATE))
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            setContentView(TextView(this).apply {
                text = "This device's Android System WebView is too old.\nUpdate 'Android System WebView' (or Chrome) in Google Play, then reopen."
                setPadding(32, 64, 32, 32)
            })
            return
        }
        ready = true
        buildUi()
        setupWebView()
        handleUri(intent?.data)
        web.loadUrl("https://x.com/home")
        ui.post(beat)
    }

    private fun btn(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 12f; setOnClickListener { onClick() }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        bar.addView(btn("Dashboard") { openDashboard() })
        bar.addView(btn("Float") { enterPip() })
        bar.addView(btn("Test") { testBridge() })
        bar.addView(btn("Reload") { web.reload() })
        bar.addView(btn("X home") { web.loadUrl("https://x.com/home") })
        bar.addView(btn("Pair") { showPairDialog() })
        bar.addView(btn("Clear session") { confirmClear() })
        bar.addView(btn("Close") { finish() })
        toolbar = HorizontalScrollView(this).apply { addView(bar) }
        root.addView(toolbar)
        statusView = TextView(this).apply { setTextColor(Color.LTGRAY); textSize = 11f; setPadding(12, 4, 12, 4) }
        root.addView(statusView)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        updateStatus()
    }

    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(false)
        web.settings.apply {
            javaScriptEnabled = true          // required by x.com
            domStorageEnabled = true          // required by x.com
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)   // challenge widgets may need it
        collectorJs = assets.open("collector.js").bufferedReader().use { it.readText() }
        // Preferred: injected at document start and message channel restricted to https://x.com (other frames get neither).
        WebViewCompat.addDocumentStartJavaScript(web, collectorJs, setOf("https://x.com"))
        WebViewCompat.addWebMessageListener(web, "XBSBridge", setOf("https://x.com")) { _, message, sourceOrigin, isMainFrame, _ ->
            val o = sourceOrigin
            if (isMainFrame && o.scheme == "https" && o.host == "x.com") message.data?.let { onPageMessage(it, "webmsg") }
        }
        web.addJavascriptInterface(NativeBridge(), "XBSNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                val host = u.host ?: return true
                val ok = u.scheme == "https" && (host == "x.com" || host.endsWith(".x.com") ||
                        host == "twitter.com" || host.endsWith(".twitter.com"))
                if (!ok) Toast.makeText(this@MainActivity, "Blocked navigation outside X: $host", Toast.LENGTH_SHORT).show()
                return !ok
            }
            // Fallback: if the document-start injection did not run, inject now (the script is idempotent).
            override fun onPageFinished(view: WebView, url: String?) {
                if (url != null && url.startsWith("https://x.com")) view.evaluateJavascript(collectorJs, null)
            }
        }
    }

    // ---------- page -> app
    private fun onPageMessage(data: String, transport: String) {
        if (data.length > 600_000) return
        val o = try { JSONObject(data) } catch (e: Exception) { return }
        msgs++; via = transport
        val s = o.optInt("seq", -1)
        when (o.optString("t")) {
            "state" -> {
                auth = o.optString("auth", "unknown"); page = o.optString("page", "other")
                pageChallenge = o.optString("challenge", "").ifEmpty { null }
                endOfResults = o.optBoolean("end", false); pageSeq = s; diag = o.optJSONObject("diag")
            }
            "records" -> if (backendState == "running" && !enriching && !hold) {
                posted++
                val body = JSONObject().put("query", query).put("seq", s).put("records", o.optJSONArray("records") ?: JSONArray())
                client.post("/api/bridge/in/records", body) { r -> onAccepted(r) }
            }
            "relations" -> if (backendState == "running" && !enriching && !hold) {
                posted++
                val body = JSONObject().put("kind", o.optString("kind")).put("seq", s).put("users", o.optJSONArray("users") ?: JSONArray())
                client.post("/api/bridge/in/relations", body) { r -> onAccepted(r) }
            }
            "profile" -> {
                val body = JSONObject().put("seq", s).put("profile", o.optJSONObject("profile") ?: JSONObject())
                client.post("/api/bridge/in/profile", body) { }
            }
            "profiles" -> {
                val body = JSONObject().put("profiles", o.optJSONArray("profiles") ?: JSONArray())
                client.post("/api/bridge/in/profiles", body) { }
            }
        }
        updateStatus()
    }

    private fun onAccepted(r: JSONObject?) {
        if (r == null) return
        backendState = r.optString("state", backendState)
        accepted += r.optInt("accepted", 0)
        pushControl(); updateStatus()
    }

    // ---------- app <-> backend
    private fun heartbeat() {
        val pipe = JSONObject().put("msgs", msgs).put("posted", posted).put("accepted", accepted).put("via", via)
        val body = JSONObject().put("app", "2.2.0").put("auth", auth).put("page", page)
            .put("challenge", pageChallenge ?: JSONObject.NULL).put("end", endOfResults).put("seq", pageSeq)
            .put("diag", diag ?: JSONObject()).put("pipe", pipe)
        client.post("/api/bridge/in/heartbeat", body) { r ->
            connected = r != null
            if (r != null) {
                backendState = r.optString("state", "idle")
                query = r.optString("query", "")
                seq = r.optInt("seq", 0)
                hold = r.optBoolean("hold", false)
                autoscroll = r.optJSONObject("opts")?.optBoolean("autoscroll", false) == true
                r.optJSONObject("mode")?.let { modeKind = it.optString("kind", "search"); modeTarget = it.optString("target", "") }
                r.optJSONArray("commands")?.let { arr -> for (i in 0 until arr.length()) handleCommand(arr.getJSONObject(i)) }
                pushControl()
            }
            toolbar.parent?.let { (it as View).keepScreenOn = connected && backendState == "running" }   // a sleeping screen would pause the page
            updateStatus()
        }
    }

    private fun handleCommand(o: JSONObject) {
        when (o.optString("action")) {
            "open" -> { val u = Uri.parse(o.optString("url")); if (u.scheme == "https" && u.host == "x.com") web.loadUrl(u.toString()) }
            "reset_seen" -> { accepted = 0; posted = 0; web.evaluateJavascript("window.__xbs&&window.__xbs.ctl({reset:true})", null) }
            "enrich" -> {
                val a = o.optJSONArray("usernames") ?: return
                for (i in 0 until a.length()) { val n = a.optString(i); if (Regex("\\w{1,15}").matches(n)) enrichQueue.addLast(n) }
                if (!enriching && enrichQueue.isNotEmpty()) { enriching = true; nextProfile() }
            }
            "clear_browser" -> clearSession()
        }
    }

    /** Tells the page script what to do now: which step (mode), whether to collect, whether to auto-scroll. */
    private fun pushControl() {
        val active = backendState == "running" && !enriching && !hold
        val msg = JSONObject().put("active", active).put("autoscroll", active && autoscroll).put("seq", seq)
            .put("mode", JSONObject().put("kind", modeKind).put("target", modeTarget))
        web.evaluateJavascript("window.__xbs&&window.__xbs.ctl($msg)", null)
    }

    // ---------- optional slow profile enrichment (user-triggered from the dashboard)
    private fun nextProfile() {
        if (enrichQueue.isEmpty()) { enriching = false; pushControl(); updateStatus(); return }
        if (pageChallenge != null || backendState == "paused") { ui.postDelayed({ nextProfile() }, 3000); return }
        pushControl()
        val u = enrichQueue.removeFirst()
        web.loadUrl("https://x.com/$u")
        ui.postDelayed({ web.evaluateJavascript("window.__xbs&&window.__xbs.profile()", null) }, 6000L + (0..1500).random())
        ui.postDelayed({ nextProfile() }, 6000L + (6000..11000).random())
        updateStatus()
    }

    // ---------- toolbar actions
    private fun openDashboard() {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:${client.port()}/"))) }
        catch (e: Exception) { Toast.makeText(this, "Open http://127.0.0.1:${client.port()} in your browser", Toast.LENGTH_LONG).show() }
    }

    /** One tap check of the page -> app path: is the script present, which transport, did a message arrive. */
    private fun testBridge() {
        val before = msgs
        web.evaluateJavascript("(function(){return window.__xbs?window.__xbs.ping():'NO_SCRIPT'})()") { res ->
            ui.postDelayed({
                val got = msgs > before
                Toast.makeText(this, "page script: ${res?.trim('"')} · message reached app: ${if (got) "YES" else "NO"} · backend: ${if (connected) "connected" else "not reachable"}",
                    Toast.LENGTH_LONG).show()
            }, 1200)
        }
    }

    /** Floating mini window keeps the X page alive while you use the dashboard in your browser (Android stops hidden pages). */
    private fun enterPip() {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            Toast.makeText(this, "Floating window not supported - use split-screen instead", Toast.LENGTH_LONG).show(); return
        }
        try { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16)).build()) }
        catch (e: Exception) { Toast.makeText(this, "Could not float: use split-screen instead", Toast.LENGTH_LONG).show() }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (ready && connected && backendState == "running") enterPip()      // keep collecting when you switch to the browser
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (!ready) return
        val v = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
        toolbar.visibility = v; statusView.visibility = v
    }

    // ---------- UI helpers
    private fun updateStatus() {
        if (!ready) return
        val d = diag
        statusView.text = "backend: ${if (connected) "connected" else if (client.configured()) "NOT reachable" else "not paired"} · X: $auth · " +
            "$backendState · step: $modeKind${if (modeTarget.isNotEmpty()) " $modeTarget" else ""}${if (hold) " (settling)" else ""} · page: $page\n" +
            "page→app msgs: $msgs${if (via.isNotEmpty()) " via $via" else " (none yet!)"} · posted: $posted · accepted: $accepted" +
            (if (d != null) " · on page: ${d.optInt("articles")} posts, ${d.optInt("cells")} users, api-batches ${d.optInt("net")}, right page=${d.optBoolean("scope")}" else "") +
            (if (enriching) " · enriching ${enrichQueue.size} left" else "") +
            (pageChallenge?.let { " · CHALLENGE: $it - solve it here, then Resume in the dashboard" } ?: "")
    }

    private fun showPairDialog() {
        val tok = EditText(this).apply { hint = "pairing token (dashboard > Show pairing)"; setText(client.token()); inputType = InputType.TYPE_CLASS_TEXT }
        val port = EditText(this).apply { hint = "port"; setText(client.port()); inputType = InputType.TYPE_CLASS_NUMBER }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 16, 32, 0); addView(tok); addView(port) }
        AlertDialog.Builder(this).setTitle("Pair with XBotScope").setView(box)
            .setPositiveButton("Save") { _, _ ->
                val ok = client.savePairing(tok.text.toString().trim(), port.text.toString().trim())
                Toast.makeText(this, if (ok) "Paired" else "Invalid token or port", Toast.LENGTH_SHORT).show()
            }.setNegativeButton("Cancel", null).show()
    }

    private fun confirmClear() {
        AlertDialog.Builder(this).setTitle("Clear browser session?")
            .setMessage("Logs you out of X and deletes this browser's cookies, cache and site data. Saved XBotScope results are not touched.")
            .setPositiveButton("Clear") { _, _ -> clearSession() }.setNegativeButton("Cancel", null).show()
    }

    /** Deletes the WebView's own website data. Cookies are only ever deleted here, never read. */
    private fun clearSession() {
        enrichQueue.clear(); enriching = false
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        web.clearCache(true); web.clearHistory(); web.clearFormData()
        web.loadUrl("about:blank")
        Toast.makeText(this, "Browser session cleared", Toast.LENGTH_SHORT).show()
    }

    private fun handleUri(d: Uri?) {
        if (d == null) return
        if (d.scheme == "xbotscope" && d.host == "pair") {
            val ok = client.savePairing(d.getQueryParameter("token") ?: "", d.getQueryParameter("port") ?: "8080")
            Toast.makeText(this, if (ok) "Paired with XBotScope" else "Invalid pairing link", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); if (ready) handleUri(intent.data) }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (ready && web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        if (ready) web.destroy()
        super.onDestroy()
    }
}
