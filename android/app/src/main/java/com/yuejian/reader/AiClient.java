package com.yuejian.reader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

final class AiClient {
    interface Progress { void update(int percent, String message); }

    private static final String CHUNK_PROMPT = "你是中文阅读研究助理。只依据所给书籍分段生成紧凑阅读笔记。按【段落主线】【关键论点】【概念与人物】【证据或例子】【与全书关系】【读者问题】六项输出；不确定处写本段未充分支持，不得虚构。";
    private static final String ANALYSIS_PROMPT = "你是严谨的中文阅读导师。只依据输入笔记生成深度阅读报告，不得虚构。只输出严格 JSON，不要 Markdown。必须含：schema_version=2；one_sentence；book_purpose；domain{primary,secondary,difficulty,book_type,best_for}；executive_summary{overview,distinctive_value,prerequisites,limitations}；outline[{title,summary}]；key_points[{title,detail,chapters}]；core_concepts[{term,explanation,importance,chapters}]；argument_map[{stage,claim,support,connection}]；chapter_connections[{chapters,connection,reading_tip}]；reading_guide{before_reading,reading_path[{stage,chapters,focus,question}],reading_methods}；key_figures[{name,role,importance,chapters}]；misconceptions[{misconception,clarification,why}]；critical_questions[{question,why_it_matters,chapters}]；practical_insights[{insight,how_to_use}]；memory_cards[{question,answer}]；further_directions[{direction,reason}]；caveat。每数组 2-6 项，确保 JSON 完整闭合。";
    private static final String BALANCE_WARNING = "AI API 余额或可用额度不足，请前往服务商控制台充值或检查计费账户后重试。";

    static JSONObject analyze(JSONObject config, BookRepository repository, String bookId, String title, String text, AtomicBoolean cancelled, Progress progress) throws Exception {
        int chunkSize = 36000, count = Math.max(1, (text.length() + chunkSize - 1) / chunkSize);
        StringBuilder notes = new StringBuilder();
        for (int i = 0; i < count; i++) {
            if (cancelled.get()) throw new InterruptedException("分析已取消");
            int start = i * chunkSize, end = Math.min(text.length(), start + chunkSize);
            progress.update(Math.max(3, i * 75 / count), "正在阅读分段 " + (i + 1) + "/" + count);
            String piece = text.substring(start, end), cacheKey = hash("notes-v2\n" + config.optString("provider") + "\n" + config.optString("model") + "\n" + bookId + "\n" + hash(piece));
            String note = repository.chunkNote(cacheKey);
            if (note.isEmpty()) { note = request(config, CHUNK_PROMPT, "书名：" + title + "\n分段：" + (i + 1) + "/" + count + "\n\n" + piece, false, 1500); repository.saveChunkNote(cacheKey, bookId, note.substring(0, Math.min(3000, note.length())), config.optString("provider"), config.optString("model")); }
            notes.append("\n【分段 ").append(i + 1).append('/').append(count).append("】\n").append(note);
        }
        if (cancelled.get()) throw new InterruptedException("分析已取消");
        progress.update(82, "正在汇总深度报告");
        String input = "书名：" + title + "\n\n逐段笔记：" + notes;
        String raw = request(config, ANALYSIS_PROMPT, input, true, 6500); JSONObject parsed;
        try { parsed = parseObject(raw); validate(parsed); }
        catch (Exception first) { parsed = parseObject(request(config, ANALYSIS_PROMPT + "\n上次输出不完整。这次每个数组只写2项、每项不超过70字，确保 JSON 完整闭合。", input, true, 5200)); validate(parsed); }
        parsed.put("schema_version", 2);
        progress.update(100, "分析完成");
        return parsed;
    }

    static String ask(JSONObject config, String title, String excerpts, String question) throws Exception {
        return request(config, "你是中文阅读助手。只根据给出的书籍摘录回答；不确定时直接说明。用中文简洁回答，并尽可能指出相关章节。", "书名：" + title + "\n\n书籍摘录：\n" + excerpts + "\n\n问题：" + question, false, 2600);
    }

    static String explain(JSONObject config, String title, String quote) throws Exception {
        return request(config, "你是中文阅读导师。只解释所给原文：先概括含义，再说明上下文可能作用、关键概念和阅读提示；无法从片段确认的背景需明确说明，不得虚构。", "书名：" + title + "\n\n选段：\n" + quote, false, 1800);
    }

    static String request(JSONObject config, String instructions, String input, boolean jsonOutput, int maxTokens) throws Exception {
        String provider = config.optString("provider"), model = config.optString("model"), key = config.optString("apiKey");
        if (key.isEmpty()) throw new IllegalArgumentException("尚未配置 API 密钥");
        JSONObject body = new JSONObject().put("model", model);
        String endpoint;
        if ("deepseek".equals(provider)) {
            endpoint = "https://api.deepseek.com/chat/completions";
            body.put("messages", new JSONArray().put(new JSONObject().put("role", "system").put("content", instructions)).put(new JSONObject().put("role", "user").put("content", input))).put("stream", false).put("max_tokens", maxTokens);
            if (jsonOutput) body.put("response_format", new JSONObject().put("type", "json_object"));
        } else if ("openai".equals(provider)) {
            endpoint = "https://api.openai.com/v1/responses";
            body.put("instructions", instructions).put("input", input).put("max_output_tokens", maxTokens);
        } else throw new IllegalArgumentException("不支持的 AI 服务商");

        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(endpoint).openConnection();
                connection.setRequestMethod("POST"); connection.setConnectTimeout(30000); connection.setReadTimeout(180000); connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + key); connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(payload); }
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
                String response = new String(readAll(stream), StandardCharsets.UTF_8);
                if (status < 200 || status >= 300) {
                    last = httpError(status, response);
                    if (BALANCE_WARNING.equals(last.getMessage())) throw last;
                    if (!(status == 408 || status == 429 || status >= 500)) throw last;
                } else {
                    JSONObject value = new JSONObject(response);
                    if ("deepseek".equals(provider)) return value.getJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content");
                    String direct = value.optString("output_text"); if (!direct.isEmpty()) return direct;
                    StringBuilder text = new StringBuilder(); JSONArray output = value.optJSONArray("output");
                    if (output != null) for (int i = 0; i < output.length(); i++) { JSONArray content = output.getJSONObject(i).optJSONArray("content"); if (content != null) for (int j = 0; j < content.length(); j++) text.append(content.getJSONObject(j).optString("text")); }
                    if (text.length() > 0) return text.toString();
                    throw new IllegalArgumentException("AI 服务没有返回文字内容");
                }
            } catch (Exception error) { if (BALANCE_WARNING.equals(error.getMessage())) throw error; last = error; }
            finally { if (connection != null) connection.disconnect(); }
            if (attempt < 2) Thread.sleep(800L << attempt);
        }
        throw last == null ? new IllegalArgumentException("AI 请求失败") : last;
    }

    private static Exception httpError(int status, String response) {
        String lower = String.valueOf(response).toLowerCase(Locale.ROOT);
        String[] markers = {"insufficient_quota","insufficient quota","insufficient balance","account balance","billing","payment required","credit balance","recharge","余额不足","额度不足","欠费","充值"};
        if (status == 402) return new IllegalArgumentException(BALANCE_WARNING);
        for (String marker : markers) if (lower.contains(marker)) return new IllegalArgumentException(BALANCE_WARNING);
        if (status == 429) return new IllegalArgumentException("AI API 请求过于频繁或已达到速率限制，请稍后重试。");
        return new IllegalArgumentException("AI 服务返回 HTTP " + status + "：" + response.substring(0, Math.min(300, response.length())));
    }

    private static JSONObject parseObject(String raw) throws Exception {
        String cleaned = raw == null ? "" : raw.trim().replaceFirst("(?is)^```(?:json)?\\s*", "").replaceFirst("(?is)\\s*```$", "");
        int start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) cleaned = cleaned.substring(start, end + 1);
        try { return new JSONObject(cleaned); }
        catch (Exception error) { throw new IllegalArgumentException("AI 返回的报告不是完整 JSON，请重试"); }
    }

    private static void validate(JSONObject value) throws Exception {
        if (value.optString("one_sentence").trim().isEmpty() || value.optString("book_purpose").trim().isEmpty()) throw new IllegalArgumentException("AI 报告缺少必要字段");
        String[] arrays = {"outline","key_points","core_concepts","argument_map","chapter_connections","key_figures","misconceptions","critical_questions","practical_insights","memory_cards","further_directions"};
        for (String key : arrays) if (value.optJSONArray(key) == null) value.put(key, new JSONArray());
        if (value.optJSONObject("domain") == null) value.put("domain", new JSONObject()); if (value.optJSONObject("executive_summary") == null) value.put("executive_summary", new JSONObject()); if (value.optJSONObject("reading_guide") == null) value.put("reading_guide", new JSONObject());
    }

    private static String hash(String text) throws Exception { byte[] value = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)); StringBuilder out = new StringBuilder(); for (byte b : value) out.append(String.format("%02x", b)); return out.toString(); }

    private static byte[] readAll(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] buffer = new byte[16384]; int read; while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read); return out.toByteArray(); }
    }
}
