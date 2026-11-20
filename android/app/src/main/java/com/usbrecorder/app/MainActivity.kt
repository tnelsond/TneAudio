package com.usbrecorder.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var pageReady = false
    private var pendingMic: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var exportFile: File? = null
    private var exportStream: FileOutputStream? = null
    private var exportName = "export.wav"
    private val sharedUris = mutableListOf<Uri>()
    private val pendingShared = mutableListOf<Int>()

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val req = pendingMic
        pendingMic = null
        if (req != null) {
            if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
        }
    }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }

    private val saveDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("audio/wav")) { uri ->
        val f = exportFile
        if (uri != null && f != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { out -> f.inputStream().use { it.copyTo(out) } }
                Toast.makeText(this, "Saved $exportName", Toast.LENGTH_SHORT).show()
            } catch (e: IOException) {
                Toast.makeText(this, "Save failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
        f?.delete()
        exportFile = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        // Serve the bundled web app from a secure https origin (needed for mic + AudioWorklet).
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", AssetHandler())
            .addPathHandler("/shared/", SharedHandler())
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                flushShared()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED
                        ) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        } else {
                            pendingMic?.deny()
                            pendingMic = request
                            micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    } else request.deny()
                }
            }

            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(arrayOf())
                fileCallback = callback
                pickFiles.launch(arrayOf("audio/*", "video/webm", "application/ogg"))
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        handleIntent(intent)
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    // "Share to" / "Open with" an audio file from another app.
    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
            Intent.ACTION_SEND -> intentStream(intent)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE -> uris.addAll(intentStreams(intent))
        }
        for (u in uris) {
            sharedUris.add(u)
            pendingShared.add(sharedUris.size - 1)
        }
        if (uris.isNotEmpty()) flushShared()
    }

    @Suppress("DEPRECATION")
    private fun intentStream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun intentStreams(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

    private fun flushShared() {
        if (!pageReady || pendingShared.isEmpty()) return
        val arr = JSONArray()
        for (i in pendingShared) {
            arr.put(JSONObject().put("url", "https://appassets.androidplatform.net/shared/$i").put("name", displayName(sharedUris[i])))
        }
        pendingShared.clear()
        web.evaluateJavascript("window.importSharedAudio && window.importSharedAudio($arr)", null)
    }

    private fun displayName(uri: Uri): String {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0) ?: "Shared audio"
            }
        } catch (_: Exception) { }
        return uri.lastPathSegment ?: "Shared audio"
    }

    private fun mimeFor(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "png" -> "image/png"
        "json", "webmanifest" -> "application/json"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    private inner class AssetHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? = try {
            WebResourceResponse(mimeFor(path), "utf-8", assets.open(path))
        } catch (e: IOException) { null }
    }

    private inner class SharedHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val uri = path.substringBefore('?').toIntOrNull()?.let { sharedUris.getOrNull(it) } ?: return null
            return try {
                WebResourceResponse("application/octet-stream", null, contentResolver.openInputStream(uri))
            } catch (e: Exception) { null }
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun beginFile(name: String) {
            exportStream?.close()
            exportName = name
            val f = File(cacheDir, "export.wav")
            exportFile = f
            exportStream = FileOutputStream(f)
        }

        @JavascriptInterface
        fun appendBase64(chunk: String) {
            exportStream?.write(Base64.decode(chunk, Base64.DEFAULT))
        }

        @JavascriptInterface
        fun finishFile() {
            exportStream?.close()
            exportStream = null
            runOnUiThread { saveDoc.launch(exportName) }
        }

        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }
}
