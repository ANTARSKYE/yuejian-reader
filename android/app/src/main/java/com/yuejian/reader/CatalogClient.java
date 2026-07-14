package com.yuejian.reader;

import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;


final class CatalogClient {
    static JSONObject search(String query) throws Exception {
        query = query == null ? "" : query.trim();
        if (query.isEmpty() || query.length() > 100) throw new IllegalArgumentException("请输入书名或作者");
        String endpoint = "https://www.gutenberg.org/ebooks/search.opds/?query=" + URLEncoder.encode(query, "UTF-8");
        byte[] xml = get(endpoint, 3 * 1024 * 1024);
        Document document = SafeXml.parse(xml);
        JSONArray books = new JSONArray(); NodeList entries = document.getElementsByTagNameNS("*", "entry");
        for (int i = 0; i < entries.getLength() && books.length() < 30; i++) {
            Element entry = (Element) entries.item(i); String title = text(entry, "title"), author = "", download = "", page = "";
            NodeList authors = entry.getElementsByTagNameNS("*", "author"); if (authors.getLength() > 0) author = text((Element) authors.item(0), "name");
            NodeList links = entry.getElementsByTagNameNS("*", "link");
            for (int j = 0; j < links.getLength(); j++) {
                Element link = (Element) links.item(j); String href = link.getAttribute("href"), type = link.getAttribute("type"), rel = link.getAttribute("rel");
                if (href.startsWith("https://") && (type.contains("epub") || href.matches("(?i).*\\.epub(?:\\?.*)?$"))) { if (download.isEmpty() || href.contains("images")) download = href; }
                if (href.startsWith("https://") && (rel.contains("alternate") || type.contains("html"))) page = href;
            }
            if (!download.isEmpty()) books.put(new JSONObject().put("title", title).put("author", author).put("downloadUrl", download).put("pageUrl", page).put("source", "Project Gutenberg"));
        }
        try {
            String api = "https://zh.wikisource.org/w/api.php?action=query&list=search&srnamespace=0&format=json&utf8=1&srlimit=12&srsearch=" + URLEncoder.encode(query, "UTF-8");
            JSONObject wikiResult = new JSONObject(new String(get(api, 2 * 1024 * 1024), StandardCharsets.UTF_8));
            JSONArray found = wikiResult.getJSONObject("query").getJSONArray("search");
            for (int i = 0; i < found.length(); i++) { String wikiTitle = found.getJSONObject(i).optString("title"); books.put(new JSONObject().put("title", wikiTitle).put("author", "中文维基文库").put("downloadUrl", "").put("pageUrl", "https://zh.wikisource.org/wiki/" + URLEncoder.encode(wikiTitle, "UTF-8").replace("+", "%20")).put("source", "中文维基文库")); }
        } catch (Exception ignored) {}
        String wiki = "https://zh.wikisource.org/w/index.php?search=" + URLEncoder.encode(query, "UTF-8") + "&title=Special%3A%E6%90%9C%E7%B4%A2&ns0=1";
        return new JSONObject().put("books", books).put("wikisourceUrl", wiki).put("rightsNotice", "仅下载有权阅读的公版或授权作品；Project Gutenberg 的公版标记以美国法律为基础，请同时遵守所在地规则。");
    }

    static JSONObject download(File cacheDir, BookRepository repository, String address, String title) throws Exception {
        URL url = new URL(address); validateHost(url);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection(); connection.setConnectTimeout(30000); connection.setReadTimeout(90000); connection.setRequestProperty("User-Agent", "YuejianAndroid/1.0"); connection.setInstanceFollowRedirects(true);
        int status = connection.getResponseCode(); if (status < 200 || status >= 300) throw new IllegalArgumentException("公益书库下载失败（HTTP " + status + "）");
        validateHost(connection.getURL()); String type = connection.getContentType() == null ? "" : connection.getContentType();
        boolean epub = type.contains("epub") || connection.getURL().getPath().toLowerCase(Locale.ROOT).contains(".epub");
        File file = File.createTempFile("catalog-", epub ? ".epub" : ".txt", cacheDir); long total = 0;
        try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(file)) { byte[] buffer = new byte[65536]; int read; while ((read = in.read(buffer)) >= 0) { total += read; if (total > 30L * 1024 * 1024) throw new IllegalArgumentException("在线书籍超过 30MB"); out.write(buffer, 0, read); } }
        finally { connection.disconnect(); }
        try { return repository.importDownloaded(file, safeName(title) + (epub ? ".epub" : ".txt")); }
        finally { file.delete(); }
    }

    private static byte[] get(String address, int limit) throws Exception { HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection(); c.setConnectTimeout(30000); c.setReadTimeout(60000); c.setRequestProperty("User-Agent", "YuejianAndroid/1.0"); try { int s = c.getResponseCode(); if (s < 200 || s >= 300) throw new IllegalArgumentException("在线书库暂不可用（HTTP " + s + "）"); try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) >= 0) { if (out.size() + n > limit) throw new IllegalArgumentException("在线书库响应过大"); out.write(b, 0, n); } return out.toByteArray(); } } finally { c.disconnect(); } }
    private static void validateHost(URL url) { String host = url.getHost().toLowerCase(Locale.ROOT); if (!"https".equals(url.getProtocol()) || !(host.equals("gutenberg.org") || host.equals("www.gutenberg.org") || host.endsWith(".gutenberg.org"))) throw new IllegalArgumentException("下载地址不受信任"); }
    private static String text(Element root, String tag) { NodeList nodes = root.getElementsByTagNameNS("*", tag); return nodes.getLength() == 0 ? "" : nodes.item(0).getTextContent().trim(); }
    private static String safeName(String title) { String name = title == null ? "在线书籍" : title.replaceAll("[\\\\/:*?\"<>|]", "_").trim(); return name.isEmpty() ? "在线书籍" : name.substring(0, Math.min(100, name.length())); }
}
