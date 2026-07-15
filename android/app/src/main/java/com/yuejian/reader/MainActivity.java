package com.yuejian.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Toast;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowInsetsController;

import org.json.JSONObject;
import org.xml.sax.SAXException;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final int PICK_BOOK = 1001;
    private static final int EXPORT_BACKUP = 1002;
    private static final int RESTORE_BACKUP = 1003;
    private static final int WEB_FILE = 1004;
    private WebView webView;
    private BookRepository repository;
    private SecureConfig secureConfig;
    private AccountStore accountStore;
    private SyncManager syncManager;
    private Uri pendingImportUri;
    private ValueCallback<Uri[]> webFileCallback;
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final ScheduledExecutorService automaticSync = Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean automaticSyncStarted = new AtomicBoolean(false);
    private final Map<String, AtomicBoolean> aiJobs = new ConcurrentHashMap<>();

    private static final class ReaderWebView extends WebView {
        ReaderWebView(Context context) { super(context); }

        @Override public ActionMode startActionMode(ActionMode.Callback callback) {
            return startActionMode(callback, ActionMode.TYPE_FLOATING);
        }

        @Override public ActionMode startActionMode(ActionMode.Callback callback, int type) {
            ActionMode.Callback2 quiet = new ActionMode.Callback2() {
                @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                    boolean created = callback.onCreateActionMode(mode, menu);
                    menu.clear();
                    return created;
                }
                @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                    callback.onPrepareActionMode(mode, menu);
                    menu.clear();
                    return true;
                }
                @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return false; }
                @Override public void onDestroyActionMode(ActionMode mode) { callback.onDestroyActionMode(mode); }
                @Override public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                    if (callback instanceof ActionMode.Callback2) ((ActionMode.Callback2) callback).onGetContentRect(mode, view, outRect);
                    else super.onGetContentRect(mode, view, outRect);
                }
            };
            return super.startActionMode(quiet, type);
        }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        repository = new BookRepository(this);
        secureConfig = new SecureConfig(this);
        accountStore = new AccountStore(this);
        syncManager = new SyncManager(repository, accountStore);
        if (Intent.ACTION_VIEW.equals(getIntent().getAction())) pendingImportUri = getIntent().getData();
        webView = new ReaderWebView(this);
        setContentView(webView);
        configureWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    () -> requestBack(true));
        }
        webView.loadUrl("https://app.local/index.html");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        int systemZoom = Math.round(getResources().getConfiguration().fontScale * 100f);
        settings.setTextZoom(Math.max(85, Math.min(160, systemZoom)));
        settings.setSafeBrowsingEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.addJavascriptInterface(new AndroidBridge(), "Yuejian");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (webFileCallback != null) webFileCallback.onReceiveValue(null);
                webFileCallback = callback;
                try { startActivityForResult(params.createIntent(), WEB_FILE); }
                catch (Exception error) { webFileCallback = null; Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show(); }
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (accountStore.accountMode()) executor.execute(() -> {
                    try { notifySyncState(syncManager.syncNow(MainActivity.this::notifySyncProgress)); } catch (Exception ignored) {}
                });
                if (pendingImportUri != null) {
                    Uri uri = pendingImportUri;
                    pendingImportUri = null;
                    importUri(uri);
                }
                if (automaticSyncStarted.compareAndSet(false, true)) {
                    automaticSync.scheduleAtFixedRate(() -> {
                        if (!accountStore.accountMode()) return;
                        try { notifySyncState(syncManager.syncNow(MainActivity.this::notifySyncProgress)); }
                        catch (Exception ignored) {}
                    }, 60, 60, TimeUnit.SECONDS);
                }
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"app.local".equals(uri.getHost())) return denied(403, "Forbidden");
                if ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath())) {
                    try { return new WebResourceResponse("text/html", "UTF-8", getAssets().open("index.html")); }
                    catch (Exception error) { return denied(500, "Asset error"); }
                }
                if ("/features.css".equals(uri.getPath()) || "/features.js".equals(uri.getPath()) || "/reader-enhancements.css".equals(uri.getPath()) || "/reader-enhancements.js".equals(uri.getPath()) || "/q-star-sky.png".equals(uri.getPath()) || "/q-cat-reading.png".equals(uri.getPath())) {
                    try {
                        String mime = uri.getPath().endsWith(".css") ? "text/css" : uri.getPath().endsWith(".js") ? "application/javascript" : "image/png";
                        return new WebResourceResponse(mime, uri.getPath().endsWith(".png") ? null : "UTF-8", getAssets().open(uri.getPath().substring(1)));
                    }
                    catch (Exception error) { return denied(500, "Asset error"); }
                }
                if (!uri.getPath().startsWith("/content/")) return denied(404, "Not found");
                try {
                    String[] parts = uri.getEncodedPath().substring("/content/".length()).split("/", 2);
                    if (parts.length != 2) return denied(404, "Not found");
                    byte[] data = repository.resource(parts[0], parts[1]);
                    String extension = MimeTypeMap.getFileExtensionFromUrl(uri.toString());
                    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
                    if (mime == null) mime = "application/octet-stream";
                    return new WebResourceResponse(mime, null, new ByteArrayInputStream(data));
                } catch (Exception ignored) { return denied(404, "Not found"); }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return request.isForMainFrame() && !("app.local".equals(uri.getHost()) && ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath())));
            }
        });
    }

    private WebResourceResponse denied(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private void notifySyncState(JSONObject value) {
        runOnUiThread(() -> webView.evaluateJavascript("window.features&&features.accountSyncFinished(" + JSONObject.quote(value.toString()) + ")", null));
    }

    private void notifySyncProgress(JSONObject value) {
        runOnUiThread(() -> webView.evaluateJavascript("window.features&&features.accountSyncProgress(" + JSONObject.quote(value.toString()) + ")", null));
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_BOOK && resultCode == RESULT_OK && data != null && data.getData() != null) importUri(data.getData());
        if (requestCode == EXPORT_BACKUP && resultCode == RESULT_OK && data != null && data.getData() != null) backupTo(data.getData());
        if (requestCode == RESTORE_BACKUP && resultCode == RESULT_OK && data != null && data.getData() != null) restoreFrom(data.getData());
        if (requestCode == WEB_FILE && webFileCallback != null) {
            Uri[] result = resultCode == RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(resultCode, data) : null;
            webFileCallback.onReceiveValue(result); webFileCallback = null;
        }
    }

    private void backupTo(Uri uri) {
        executor.execute(() -> {
            try { repository.close(); BackupManager.exportData(this, uri); repository = new BookRepository(this); nativeResult("backup", true, "备份已保存"); }
            catch (Exception error) { repository = new BookRepository(this); nativeResult("backup", false, error.getMessage()); }
        });
    }

    private void restoreFrom(Uri uri) {
        executor.execute(() -> {
            try {
                repository.close(); BackupManager.restoreData(this, uri); repository = new BookRepository(this); nativeResult("restore", true, "数据恢复完成");
                runOnUiThread(() -> webView.reload());
            } catch (Exception error) { repository = new BookRepository(this); nativeResult("restore", false, error.getMessage()); }
        });
    }

    private void importUri(Uri uri) {
        runOnUiThread(() -> webView.evaluateJavascript("window.app&&app.importStarted()", null));
        executor.execute(() -> {
            try {
                JSONObject result = repository.importBook(uri);
                String payload = JSONObject.quote(result.toString());
                runOnUiThread(() -> webView.evaluateJavascript("app.importFinished(" + payload + ")", null));
            } catch (Exception error) {
                String message = JSONObject.quote(friendlyImportError(error));
                runOnUiThread(() -> webView.evaluateJavascript("app.importFailed(" + message + ")", null));
            }
        });
    }

    private String friendlyImportError(Exception error) {
        String message = error.getMessage() == null ? "" : error.getMessage().trim();
        if (error instanceof SAXException) return "这本 EPUB 的目录文件格式不完整或已损坏，请尝试重新下载该书。";
        if (error instanceof java.util.zip.ZipException) return "这不是有效的 EPUB 压缩文件，或文件已经损坏。";
        if (message.startsWith("http://") || message.startsWith("https://") || message.contains("xml/features/"))
            return "当前 Android 系统的 XML 解析组件不兼容，已阻止本次导入。请安装修复后的新版。";
        if (message.isEmpty()) return "导入失败：无法解析这本电子书。";
        return message;
    }

    private void nativeResult(String requestId, boolean ok, Object value) {
        try {
            JSONObject event = new JSONObject().put("requestId", requestId).put("ok", ok);
            if (ok) event.put("result", value); else event.put("error", String.valueOf(value));
            String encoded = JSONObject.quote(event.toString());
            runOnUiThread(() -> webView.evaluateJavascript("window.app&&app.nativeResult(" + encoded + ")", null));
        } catch (Exception ignored) {}
    }

    private void nativeProgress(String requestId, int percent, String message) {
        String id = JSONObject.quote(requestId), text = JSONObject.quote(message);
        runOnUiThread(() -> webView.evaluateJavascript("window.app&&app.nativeProgress(" + id + "," + percent + "," + text + ")", null));
    }

    private void requestBack(boolean predictive) {
        webView.evaluateJavascript("window.app ? app.handleBack() : false", value -> {
            if (!"true".equals(value)) {
                if (predictive) finish(); else MainActivity.super.onBackPressed();
            }
        });
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { requestBack(false); }

    @Override protected void onDestroy() {
        executor.shutdownNow();
        automaticSync.shutdownNow();
        if (webView != null) webView.destroy();
        repository.close();
        super.onDestroy();
    }

    public final class AndroidBridge {
        @JavascriptInterface public void chooseBook() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/epub+zip", "text/plain"});
                startActivityForResult(intent, PICK_BOOK);
            });
        }

        @JavascriptInterface public String listBooks() {
            try { return repository.listBooks().toString(); }
            catch (Exception e) { return "[]"; }
        }

        @JavascriptInterface public void listBooksAsync(String requestId) {
            executor.execute(() -> { try { nativeResult(requestId, true, repository.listBooks()); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }

        @JavascriptInterface public String openBook(String id) {
            try { return repository.getBook(id).toString(); }
            catch (Exception e) { return errorJson(e); }
        }


        @JavascriptInterface public void openBookAsync(String requestId, String id) {
            executor.execute(() -> { try { nativeResult(requestId, true, repository.getBook(id)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }

        @JavascriptInterface public String readChapter(String id, int index) {
            try { return repository.getChapter(id, index).toString(); }
            catch (Exception e) { return errorJson(e); }
        }


        @JavascriptInterface public void readChapterAsync(String requestId, String id, int index) {
            executor.execute(() -> { try { nativeResult(requestId, true, repository.getChapter(id, index)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }

        @JavascriptInterface public void saveProgress(String id, int chapter, double progress) { repository.updateProgress(id, chapter, progress); }

        @JavascriptInterface public void deleteBook(String id) { repository.deleteBook(id); }

        @JavascriptInterface public String annotations(String bookId) {
            try { return repository.annotations(bookId).toString(); } catch (Exception error) { return "[]"; }
        }

        @JavascriptInterface public String saveAnnotation(String bookId, String json) {
            try { return repository.saveAnnotation(bookId, json).toString(); } catch (Exception error) { return errorJson(error); }
        }

        @JavascriptInterface public void deleteAnnotation(String id) { repository.deleteAnnotation(id); }

        @JavascriptInterface public String bookmarks(String bookId) {
            try { return repository.bookmarks(bookId).toString(); } catch (Exception error) { return "[]"; }
        }

        @JavascriptInterface public String toggleBookmark(String bookId, int chapter, double position, String label) {
            try { return repository.toggleBookmark(bookId, chapter, position, label).toString(); } catch (Exception error) { return errorJson(error); }
        }

        @JavascriptInterface public String getState(String key, String fallback) { return repository.state(key, fallback); }
        @JavascriptInterface public void setState(String key, String value) { repository.saveState(key, value); }
        @JavascriptInterface public String readingStats() { try { return repository.readingStats().toString(); } catch (Exception error) { return "[]"; } }
        @JavascriptInterface public void readingStatsAsync(String requestId) { executor.execute(() -> { try { nativeResult(requestId, true, repository.readingStats()); } catch (Exception error) { nativeResult(requestId, false, message(error)); } }); }
        @JavascriptInterface public void recordReading(String bookId, long seconds, long chars, int completed) { repository.recordReading(bookId, seconds, chars, completed); }
        @JavascriptInterface public String syncChanges(long after, int limit) { try { return repository.syncChanges(after, limit).toString(); } catch (Exception error) { return errorJson(error); } }
        @JavascriptInterface public String syncStatus() { try { return syncManager.status().toString(); } catch (Exception error) { return errorJson(error); } }
        @JavascriptInterface public int acknowledgeSync(long cursor) { return repository.acknowledgeSync(cursor); }
        @JavascriptInterface public void accountLoginAsync(String requestId, String serverUrl, String username, String password, boolean register) {
            executor.execute(() -> { try { nativeResult(requestId, true, syncManager.login(serverUrl, username, password, register, "Android 手机", MainActivity.this::notifySyncProgress)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }
        @JavascriptInterface public void syncNowAsync(String requestId) {
            executor.execute(() -> { try { nativeResult(requestId, true, syncManager.syncNow(MainActivity.this::notifySyncProgress)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }
        @JavascriptInterface public void accountLogoutAsync(String requestId) {
            executor.execute(() -> { try { nativeResult(requestId, true, syncManager.logout()); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }
        @JavascriptInterface public void setSystemTheme(boolean dark, String color) {
            runOnUiThread(() -> {
                try { getWindow().setStatusBarColor(Color.parseColor(color)); getWindow().setNavigationBarColor(Color.parseColor(color)); }
                catch (Exception ignored) {}
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController controller = getWindow().getInsetsController();
                    if (controller != null) {
                        int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
                    }
                } else {
                    int flags = dark ? 0 : android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    getWindow().getDecorView().setSystemUiVisibility(flags);
                }
            });
        }
        @JavascriptInterface public String aiStatus() { try { return secureConfig.status().toString(); } catch (Exception error) { return errorJson(error); } }
        @JavascriptInterface public String storageStatus() { try { return repository.storageStatus().toString(); } catch (Exception error) { return errorJson(error); } }
        @JavascriptInterface public void storageStatusAsync(String requestId) { executor.execute(() -> { try { nativeResult(requestId, true, repository.storageStatus()); } catch (Exception error) { nativeResult(requestId, false, message(error)); } }); }
        @JavascriptInterface public void loadAnalysisAsync(String requestId, String bookId) { executor.execute(() -> { try { nativeResult(requestId, true, repository.loadAnalysis(bookId)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } }); }
        @JavascriptInterface public int clearAnalysis(String bookId) { return repository.clearAnalysis(bookId); }

        @JavascriptInterface public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("阅见摘录", text == null ? "" : text));
                Toast.makeText(MainActivity.this, "已复制", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface public void shareText(String subject, String text) {
            runOnUiThread(() -> {
                Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, subject == null ? "阅见摘录" : subject)
                        .putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                startActivity(Intent.createChooser(share, "分享阅读书签"));
            });
        }

        @JavascriptInterface public void exportBackup() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, "yuejian-android-backup.zip");
                startActivityForResult(intent, EXPORT_BACKUP);
            });
        }

        @JavascriptInterface public void restoreBackup() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip");
                startActivityForResult(intent, RESTORE_BACKUP);
            });
        }

        @JavascriptInterface public void configureAi(String requestId, String json) {
            executor.execute(() -> {
                try {
                    JSONObject input = new JSONObject(json);
                    String key = input.optString("apiKey");
                    if (key.isEmpty() && secureConfig.status().optBoolean("configured")) key = secureConfig.load().optString("apiKey");
                    JSONObject config = new JSONObject().put("provider", input.optString("provider", "deepseek")).put("model", input.optString("model", "deepseek-v4-flash")).put("apiKey", key);
                    String verification = AiClient.request(config, "你正在验证 API 连接。只用中文输出“连接成功”，不要添加其他内容。", "请确认连接。", false, 80);
                    if (verification.trim().isEmpty()) throw new IllegalArgumentException("AI 服务未返回有效内容");
                    secureConfig.save(config.getString("provider"), config.getString("model"), config.getString("apiKey"));
                    nativeResult(requestId, true, secureConfig.status().put("verification", verification));
                } catch (Exception error) { nativeResult(requestId, false, message(error)); }
            });
        }

        @JavascriptInterface public void analyzeBook(String requestId, String bookId, boolean revision) {
            AtomicBoolean cancelled = new AtomicBoolean(false); aiJobs.put(requestId, cancelled);
            executor.execute(() -> {
                try {
                    JSONObject cached = repository.loadAnalysis(bookId);
                    if (!revision && cached.length() > 0) { nativeResult(requestId, true, cached.put("cached", true)); return; }
                    JSONObject book = repository.getBook(bookId), config = secureConfig.load();
                    String text = repository.searchableText(bookId, 240_000);
                    JSONObject analysis = AiClient.analyze(config, repository, bookId, book.getString("title"), text, cancelled, (percent, detail) -> nativeProgress(requestId, percent, detail));
                    repository.saveAnalysis(bookId, analysis, config.getString("provider"), config.getString("model"), revision);
                    nativeResult(requestId, true, repository.loadAnalysis(bookId).put("cached", false));
                } catch (Exception error) { nativeResult(requestId, false, message(error)); }
                finally { aiJobs.remove(requestId); }
            });
        }

        @JavascriptInterface public void askBook(String requestId, String bookId, String question) {
            executor.execute(() -> {
                try {
                    if (question == null || question.trim().isEmpty() || question.length() > 2000) throw new IllegalArgumentException("请输入有效的问题");
                    JSONObject book = repository.getBook(bookId);
                    String answer = AiClient.ask(secureConfig.load(), book.getString("title"), repository.searchableText(bookId, 120000), question.trim());
                    nativeResult(requestId, true, answer);
                } catch (Exception error) { nativeResult(requestId, false, message(error)); }
            });
        }

        @JavascriptInterface public void explainSelection(String requestId, String bookId, String quote) {
            executor.execute(() -> {
                try {
                    if (quote == null || quote.trim().isEmpty() || quote.length() > 8000) throw new IllegalArgumentException("请先选择需要解析的原文");
                    JSONObject book = repository.getBook(bookId);
                    nativeResult(requestId, true, AiClient.explain(secureConfig.load(), book.getString("title"), quote.trim()));
                } catch (Exception error) { nativeResult(requestId, false, message(error)); }
            });
        }

        @JavascriptInterface public void translateSelection(String requestId, String bookId, String quote) {
            executor.execute(() -> {
                try {
                    if (quote == null || quote.trim().isEmpty() || quote.length() > 8000) throw new IllegalArgumentException("请先选择需要翻译的原文");
                    String source = quote.trim();
                    boolean mostlyChinese = source.codePoints().filter(c -> c >= 0x4E00 && c <= 0x9FFF).count() > Math.max(2, source.length() / 8);
                    String target = mostlyChinese ? "英文" : "简体中文";
                    String system = "你是专业文学翻译。把用户提供的原文完整翻译为" + target + "，保留段落、语气、专名与标点；只输出译文，不解释。";
                    nativeResult(requestId, true, AiClient.request(secureConfig.load(), system, source, false, 5000));
                } catch (Exception error) { nativeResult(requestId, false, message(error)); }
            });
        }

        @JavascriptInterface public void cancelAi(String requestId) { AtomicBoolean job = aiJobs.get(requestId); if (job != null) job.set(true); }

        @JavascriptInterface public void searchCatalog(String requestId, String query) {
            executor.execute(() -> { try { nativeResult(requestId, true, CatalogClient.search(query)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }

        @JavascriptInterface public void downloadCatalog(String requestId, String url, String title) {
            executor.execute(() -> { try { nativeResult(requestId, true, CatalogClient.download(getCacheDir(), repository, url, title)); } catch (Exception error) { nativeResult(requestId, false, message(error)); } });
        }

        @JavascriptInterface public void openExternal(String url) {
            runOnUiThread(() -> {
                try {
                    Uri uri = Uri.parse(url);
                    if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) throw new IllegalArgumentException();
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception error) { Toast.makeText(MainActivity.this, "无法打开这个链接", Toast.LENGTH_SHORT).show(); }
            });
        }

        private String errorJson(Exception error) {
            try { return new JSONObject().put("error", error.getMessage() == null ? "操作失败" : error.getMessage()).toString(); }
            catch (Exception ignored) { return "{\"error\":\"操作失败\"}"; }
        }

        private String message(Exception error) { return error.getMessage() == null ? "操作失败" : error.getMessage(); }
    }
}
