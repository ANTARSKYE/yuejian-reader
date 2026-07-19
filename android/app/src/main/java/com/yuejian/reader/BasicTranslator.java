package com.yuejian.reader;

import android.text.Html;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

final class BasicTranslator {
    private static final int MAX_CHARS = 4000;
    private static final int CHUNK_BYTES = 450;

    static JSONObject translate(BookRepository repository, String value) throws Exception {
        String sourceText = value == null ? "" : value.trim();
        if (sourceText.isEmpty()) throw new IllegalArgumentException("请先选择需要翻译的原文");
        if (sourceText.length() > MAX_CHARS) throw new IllegalArgumentException("快速翻译每次最多 4000 个字符，请缩短选段");
        long chinese = sourceText.codePoints().filter(c -> c >= 0x4E00 && c <= 0x9FFF).count();
        String source = chinese > Math.max(2, sourceText.length() / 8) ? "zh-CN" : "autodetect";
        String target = "zh-CN".equals(source) ? "en" : "zh-CN";
        String cacheKey = "tr-v1-" + sha256(source + "\n" + target + "\n" + sourceText);
        String cached = repository.state(cacheKey, "");
        if (!cached.isEmpty()) return result(cached, target, true);

        List<String> chunks = chunks(sourceText);
        if (chunks.size() > 20) throw new IllegalArgumentException("选段分句过多，请缩短后重试");
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(4, chunks.size()));
        try {
            List<Callable<String>> tasks = new ArrayList<>();
            for (String chunk : chunks) tasks.add(() -> request(chunk, source, target));
            List<Future<String>> futures = pool.invokeAll(tasks, 12, TimeUnit.SECONDS);
            StringBuilder translated = new StringBuilder();
            for (Future<String> future : futures) {
                if (future.isCancelled()) throw new IllegalArgumentException("基础翻译响应超时，请检查网络后重试");
                if (translated.length() > 0) translated.append('\n');
                translated.append(future.get());
            }
            repository.saveTranslationCache(cacheKey, translated.toString());
            return result(translated.toString(), target, false);
        } finally { pool.shutdownNow(); }
    }

    private static JSONObject result(String text, String target, boolean cached) throws Exception {
        return new JSONObject().put("translation", text).put("target", target).put("provider", "MyMemory").put("cached", cached);
    }

    private static String request(String text, String source, String target) throws Exception {
        // The Charset overload only exists on newer Android releases. The named
        // charset overload is available across the app's full Android 8+ range.
        String query = "q=" + URLEncoder.encode(text, "UTF-8") + "&langpair=" + URLEncoder.encode(source + "|" + target, "UTF-8") + "&mt=1";
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api.mymemory.translated.net/get?" + query).openConnection();
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000); connection.setRequestProperty("User-Agent", "YuejianAndroid/1.3.0");
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String raw = new String(readAll(stream, 1_000_000), StandardCharsets.UTF_8);
            JSONObject payload = new JSONObject(raw);
            int responseStatus = payload.optInt("responseStatus", status);
            String translated = Html.fromHtml(payload.optJSONObject("responseData") == null ? "" : payload.optJSONObject("responseData").optString("translatedText"), Html.FROM_HTML_MODE_LEGACY).toString().trim();
            if (responseStatus == 200 && !translated.isEmpty()) return translated;
            String detail = payload.optString("responseDetails").toLowerCase(Locale.ROOT);
            if (detail.contains("quota") || detail.contains("limit")) throw new IllegalArgumentException("基础翻译今日公共额度暂不可用，请稍后重试或使用 AI 翻译");
            throw new IllegalArgumentException("基础翻译暂时没有返回结果，请稍后重试");
        } catch (java.net.SocketTimeoutException error) {
            throw new IllegalArgumentException("基础翻译响应超时，请检查网络后重试", error);
        } catch (java.net.UnknownHostException error) {
            throw new IllegalArgumentException("无法连接基础翻译服务，请检查网络", error);
        } finally { connection.disconnect(); }
    }

    private static List<String> chunks(String text) {
        List<String> chunks = new ArrayList<>(); StringBuilder current = new StringBuilder();
        for (int offset = 0; offset < text.length();) {
            int codePoint = text.codePointAt(offset); String value = new String(Character.toChars(codePoint));
            if (current.length() > 0 && (current.toString() + value).getBytes(StandardCharsets.UTF_8).length > CHUNK_BYTES) {
                chunks.add(current.toString().trim()); current.setLength(0);
            }
            current.append(value); offset += Character.charCount(codePoint);
        }
        if (!current.toString().trim().isEmpty()) chunks.add(current.toString().trim());
        return chunks;
    }

    private static byte[] readAll(InputStream input, int limit) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = in.read(buffer)) >= 0) { if (out.size() + count > limit) throw new IllegalArgumentException("基础翻译服务响应过大"); out.write(buffer, 0, count); }
            return out.toByteArray();
        }
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder(); for (byte b : digest) output.append(String.format("%02x", b)); return output.toString();
    }
}
