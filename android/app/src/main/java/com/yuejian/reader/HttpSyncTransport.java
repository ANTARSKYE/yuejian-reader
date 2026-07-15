package com.yuejian.reader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class HttpSyncTransport implements SyncTransport {
    private final String serverUrl;
    private final String token;

    HttpSyncTransport(String serverUrl, String token) {
        this.serverUrl = validateServerUrl(serverUrl);
        this.token = token == null ? "" : token;
    }

    static String validateServerUrl(String value) {
        try {
            String clean = value == null ? "" : value.trim().replaceAll("/+$", "");
            URI uri = URI.create(clean);
            if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))) throw new Exception();
            return clean;
        } catch (Exception error) { throw new IllegalArgumentException("请输入有效的 HTTP/HTTPS 同步服务器地址"); }
    }

    static JSONObject account(String serverUrl, String endpoint, JSONObject payload) throws Exception {
        return request(validateServerUrl(serverUrl) + endpoint, "POST", payload, "");
    }

    static String discoverServer() throws Exception {
        byte[] request = "YUEJIAN_DISCOVER_V1".getBytes(StandardCharsets.UTF_8);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true); socket.setSoTimeout(2200);
            socket.send(new DatagramPacket(request, request.length, InetAddress.getByName("255.255.255.255"), 8788));
            byte[] buffer = new byte[1024]; DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            JSONObject result = new JSONObject(new String(response.getData(), response.getOffset(), response.getLength(), StandardCharsets.UTF_8));
            if (!"yuejian-sync-discovery-v1".equals(result.optString("protocol"))) throw new IllegalStateException("发现了不兼容的同步服务器");
            return validateServerUrl(result.getString("url"));
        } catch (java.net.SocketTimeoutException timeout) {
            throw new IllegalStateException("未发现同步服务器，请先在电脑上双击“阅见同步服务器.exe”，并确认手机与电脑连接同一 Wi-Fi");
        }
    }

    JSONObject logout() throws Exception { return request(serverUrl + "/api/v1/account/logout", "POST", new JSONObject(), token); }
    @Override public JSONObject exchange(JSONObject request) throws Exception { return request(serverUrl + "/api/v1/sync/exchange", "POST", request, token); }

    boolean hasBlob(String sha256) throws Exception {
        HttpURLConnection connection = openBlob(sha256, "HEAD");
        int status = connection.getResponseCode();
        connection.disconnect();
        if (status == 404) return false;
        if (status < 200 || status >= 300) throw new IllegalStateException("同步服务器返回 HTTP " + status);
        return true;
    }

    void putBlob(String sha256, File file, String contentType) throws Exception {
        if (!file.isFile() || file.length() > 30L * 1024 * 1024) throw new IllegalArgumentException("书籍文件不存在或超过 30MB 限制");
        HttpURLConnection connection = openBlob(sha256, "PUT");
        connection.setConnectTimeout(7000); connection.setReadTimeout(30000);
        connection.setRequestProperty("Content-Type", contentType == null ? "application/octet-stream" : contentType);
        connection.setFixedLengthStreamingMode(file.length()); connection.setDoOutput(true);
        try (InputStream input = new FileInputStream(file); OutputStream output = connection.getOutputStream()) {
            byte[] buffer = new byte[64 * 1024]; int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
        int status = connection.getResponseCode();
        byte[] response = readLimited(status >= 400 ? connection.getErrorStream() : connection.getInputStream(), 1024 * 1024);
        connection.disconnect();
        if (status < 200 || status >= 300) {
            JSONObject error = response.length == 0 ? new JSONObject() : new JSONObject(new String(response, StandardCharsets.UTF_8));
            throw new IllegalStateException(error.optString("error", "书籍文件上传失败，HTTP " + status));
        }
    }

    void getBlob(String sha256, File destination) throws Exception {
        HttpURLConnection connection = openBlob(sha256, "GET");
        connection.setConnectTimeout(7000); connection.setReadTimeout(30000);
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            byte[] response = readLimited(connection.getErrorStream(), 1024 * 1024); connection.disconnect();
            if (status == 404) throw new IllegalStateException("书籍原文暂未上传");
            JSONObject error = response.length == 0 ? new JSONObject() : new JSONObject(new String(response, StandardCharsets.UTF_8));
            throw new IllegalStateException(error.optString("error", "书籍原文暂未上传"));
        }
        long declared = connection.getContentLengthLong();
        if (declared > 30L * 1024 * 1024) { connection.disconnect(); throw new IllegalStateException("书籍文件超过 30MB 限制"); }
        long total = 0;
        try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024]; int read;
            while ((read = input.read(buffer)) != -1) {
                total += read; if (total > 30L * 1024 * 1024) throw new IllegalStateException("书籍文件超过 30MB 限制");
                output.write(buffer, 0, read);
            }
        } finally { connection.disconnect(); }
    }

    private HttpURLConnection openBlob(String sha256, String method) throws Exception {
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("书籍哈希无效");
        HttpURLConnection connection = (HttpURLConnection) new URL(serverUrl + "/api/v1/blobs/" + sha256).openConnection();
        connection.setRequestMethod(method); connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    private static JSONObject request(String url, String method, JSONObject payload, String token) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(7000); connection.setReadTimeout(12000); connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setDoOutput(true);
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > 2 * 1024 * 1024) throw new IllegalArgumentException("同步请求过大");
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(body); }
        int status = connection.getResponseCode();
        InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] response = readLimited(source, 2 * 1024 * 1024);
        connection.disconnect();
        JSONObject result = response.length == 0 ? new JSONObject() : new JSONObject(new String(response, StandardCharsets.UTF_8));
        if (status < 200 || status >= 300) throw new IllegalStateException(result.optString("error", "同步服务器返回 HTTP " + status));
        return result;
    }

    private static byte[] readLimited(InputStream input, int limit) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int read, total = 0;
            while ((read = source.read(buffer)) != -1) {
                total += read; if (total > limit) throw new IllegalStateException("同步服务器响应过大");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }
}
