package com.yuejian.reader;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;


final class BookRepository extends SQLiteOpenHelper {
    private static final String EPUB_PARSER_REVISION = "2";
    private final Context context;
    private final File booksDir;

    private static final class TocEntry {
        final String path;
        final String fragment;
        final String title;
        final int depth;

        TocEntry(String path, String fragment, String title, int depth) {
            this.path = path;
            this.fragment = fragment;
            this.title = title;
            this.depth = Math.max(0, Math.min(8, depth));
        }
    }

    BookRepository(Context context) {
        super(context, "yuejian.db", null, 8);
        this.context = context.getApplicationContext();
        this.booksDir = new File(context.getFilesDir(), "books");
        this.booksDir.mkdirs();
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',cover_path TEXT NOT NULL DEFAULT '',original_name TEXT NOT NULL DEFAULT '',file_size INTEGER NOT NULL DEFAULT 0,added INTEGER NOT NULL,last_opened INTEGER NOT NULL DEFAULT 0,progress REAL NOT NULL DEFAULT 0,current_chapter INTEGER NOT NULL DEFAULT 0,chapter_count INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT '未分类',tags TEXT NOT NULL DEFAULT '[]',description TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE TABLE chapters(book_id TEXT NOT NULL,idx INTEGER NOT NULL,title TEXT NOT NULL,path TEXT NOT NULL,depth INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(book_id,idx))");
        createFeatureTables(db);
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE books ADD COLUMN author TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE books ADD COLUMN cover_path TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE books ADD COLUMN updated INTEGER NOT NULL DEFAULT 0");
            db.execSQL("ALTER TABLE books ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
            createFeatureTables(db);
        }
        if (oldVersion < 3) createFeatureTables(db);
        if (oldVersion < 4) { db.execSQL("ALTER TABLE books ADD COLUMN original_name TEXT NOT NULL DEFAULT ''"); db.execSQL("ALTER TABLE books ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0"); }
        if (oldVersion >= 2 && oldVersion < 5) {
            db.execSQL("ALTER TABLE annotations ADD COLUMN start_offset INTEGER NOT NULL DEFAULT -1");
            db.execSQL("ALTER TABLE annotations ADD COLUMN end_offset INTEGER NOT NULL DEFAULT -1");
            db.execSQL("ALTER TABLE annotations ADD COLUMN prefix TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE annotations ADD COLUMN suffix TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 6) {
            createFeatureTables(db);
            long legacyRows = 0;
            try (Cursor c = db.rawQuery("SELECT COUNT(*) FROM reading_daily", null)) { if (c.moveToFirst()) legacyRows = c.getLong(0); }
            if (legacyRows > 0) {
                String source = localSourceId(db);
                db.execSQL("INSERT OR IGNORE INTO reading_contributions(day,book_id,source_id,seconds,chars,completed,updated,deleted) SELECT day,book_id,?,seconds,chars,completed,?,0 FROM reading_daily", new Object[]{source, System.currentTimeMillis()});
                db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES('sync.reading_legacy_migrated','1',?)", new Object[]{System.currentTimeMillis()});
            }
        }
        if (oldVersion < 7) createPerformanceIndexes(db);
        if (oldVersion < 8) {
            db.execSQL("ALTER TABLE books ADD COLUMN category TEXT NOT NULL DEFAULT '未分类'");
            db.execSQL("ALTER TABLE books ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
            db.execSQL("ALTER TABLE books ADD COLUMN description TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE chapters ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
        }
    }

    private static void createFeatureTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,chapter INTEGER NOT NULL,quote TEXT NOT NULL,note TEXT NOT NULL,color TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,start_offset INTEGER NOT NULL DEFAULT -1,end_offset INTEGER NOT NULL DEFAULT -1,prefix TEXT NOT NULL DEFAULT '',suffix TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,chapter INTEGER NOT NULL,position REAL NOT NULL DEFAULT 0,label TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS analysis_cache(book_id TEXT PRIMARY KEY,json TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,updated INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS analysis_chunks(cache_key TEXT PRIMARY KEY,book_id TEXT NOT NULL,note TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,updated INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS reading_daily(day TEXT NOT NULL,book_id TEXT NOT NULL,seconds INTEGER NOT NULL DEFAULT 0,chars INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,book_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS reading_contributions(day TEXT NOT NULL,book_id TEXT NOT NULL,source_id TEXT NOT NULL,seconds INTEGER NOT NULL DEFAULT 0,chars INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,book_id,source_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS sync_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,change_id TEXT UNIQUE NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL)");
        createPerformanceIndexes(db);
    }

    private static void createPerformanceIndexes(SQLiteDatabase db) {
        db.execSQL("CREATE INDEX IF NOT EXISTS books_visible_recent ON books(deleted,last_opened,added)");
        db.execSQL("CREATE INDEX IF NOT EXISTS annotations_book_visible ON annotations(book_id,deleted,chapter,created)");
        db.execSQL("CREATE INDEX IF NOT EXISTS bookmarks_book_visible ON bookmarks(book_id,deleted,chapter,position)");
        db.execSQL("CREATE INDEX IF NOT EXISTS reading_contributions_book_visible ON reading_contributions(book_id,deleted,day)");
        db.execSQL("CREATE INDEX IF NOT EXISTS reading_daily_day ON reading_daily(day)");
        db.execSQL("CREATE INDEX IF NOT EXISTS analysis_chunks_book_updated ON analysis_chunks(book_id,updated)");
        db.execSQL("CREATE INDEX IF NOT EXISTS sync_outbox_seq ON sync_outbox(seq)");
    }

    synchronized JSONObject importBook(Uri uri) throws Exception {
        String displayName = queryName(uri);
        String lower = displayName.toLowerCase(Locale.ROOT);
        String mime = context.getContentResolver().getType(uri);
        boolean epub = lower.endsWith(".epub") || "application/epub+zip".equals(mime);
        boolean txt = lower.endsWith(".txt") || (mime != null && mime.startsWith("text/"));
        if (!epub && !txt) throw new IllegalArgumentException("仅支持 EPUB 和 TXT 文件");

        File temporary = File.createTempFile("import-", epub ? ".epub" : ".txt", context.getCacheDir());
        try (InputStream in = context.getContentResolver().openInputStream(uri); FileOutputStream out = new FileOutputStream(temporary)) {
            if (in == null) throw new IllegalArgumentException("无法读取所选文件");
            copy(in, out);
        }
        if (temporary.length() > 30L * 1024 * 1024) { temporary.delete(); throw new IllegalArgumentException("文件超过 30MB 限制"); }
        try { return importTemporary(temporary, displayName, epub); }
        finally { temporary.delete(); }
    }

    synchronized JSONObject importDownloaded(File temporary, String displayName) throws Exception {
        boolean epub = displayName.toLowerCase(Locale.ROOT).endsWith(".epub");
        return importTemporary(temporary, displayName, epub);
    }

    private JSONObject importTemporary(File temporary, String displayName, boolean epub) throws Exception {
        String id = sha256(temporary);
        File target = new File(booksDir, id);
        if (target.exists()) {
            if (!epub) try { return getBook(id); } catch (Exception ignored) { deleteTree(target); }
            if (epub) {
                double oldProgress = 0; int oldChapter = 0;
                try (Cursor c = getReadableDatabase().rawQuery("SELECT progress,current_chapter FROM books WHERE id=?", new String[]{id})) {
                    if (c.moveToFirst()) { oldProgress = c.getDouble(0); oldChapter = c.getInt(1); }
                }
                deleteTree(target); target.mkdirs();
                importEpub(temporary, target, id, displayName);
                try (InputStream in = new FileInputStream(temporary); FileOutputStream out = new FileOutputStream(new File(target, "original.epub"))) { copy(in, out); }
                markParserCurrent(id);
                JSONObject refreshed = getBook(id);
                int count = Math.max(1, refreshed.optInt("chapterCount", 1));
                getWritableDatabase().execSQL("UPDATE books SET progress=?,current_chapter=? WHERE id=?", new Object[]{oldProgress, Math.min(oldChapter, count - 1), id});
                return getBook(id);
            }
        }
        target.mkdirs();
        try {
            if (epub) importEpub(temporary, target, id, displayName);
            else importTxt(temporary, target, id, displayName);
            try (InputStream in = new FileInputStream(temporary); FileOutputStream out = new FileOutputStream(new File(target, epub ? "original.epub" : "original.txt"))) { copy(in, out); }
            if (epub) markParserCurrent(id);
            return getBook(id);
        } catch (Exception error) {
            deleteTree(target);
            SQLiteDatabase db = getWritableDatabase(); db.delete("chapters", "book_id=?", new String[]{id}); db.delete("books", "id=?", new String[]{id});
            throw error;
        }
    }

    private void importTxt(File source, File target, String id, String displayName) throws Exception {
        byte[] bytes = readAll(new FileInputStream(source));
        String text = decodeText(bytes).replace("\r\n", "\n").replace('\r', '\n').trim();
        if (text.isEmpty()) throw new IllegalArgumentException("TXT 文件没有可阅读内容");
        String title = stripExtension(displayName);
        List<String> blocks = splitTxt(text);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            upsertBook(db, id, title, "txt", "", "", displayName, source.length(), blocks.size());
            db.delete("chapters", "book_id=?", new String[]{id});
            for (int i = 0; i < blocks.size(); i++) {
                String block = blocks.get(i);
                String chapterTitle = firstMeaningfulLine(block, "第 " + (i + 1) + " 节");
                String html = "<article><h2>" + escape(chapterTitle) + "</h2>" + paragraphs(block) + "</article>";
                String path = String.format(Locale.ROOT, "chapters/%05d.html", i);
                writeFile(new File(target, path), html.getBytes(StandardCharsets.UTF_8));
                insertChapter(db, id, i, chapterTitle, path, 0);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    private void importEpub(File source, File target, String id, String displayName) throws Exception {
        unzipSecurely(source, target);
        File container = new File(target, "META-INF/container.xml");
        if (!container.isFile()) throw new IllegalArgumentException("EPUB 缺少 container.xml");
        Document containerDoc = parseXml(container);
        NodeList roots = containerDoc.getElementsByTagNameNS("*", "rootfile");
        if (roots.getLength() == 0) throw new IllegalArgumentException("EPUB 未声明内容文件");
        String opfPath = ((Element) roots.item(0)).getAttribute("full-path");
        File opfFile = safeFile(target, opfPath);
        Document opf = parseXml(opfFile);
        String title = firstTagText(opf, "title", stripExtension(displayName));
        String author = firstTagText(opf, "creator", "");
        Map<String, String> manifest = new HashMap<>();
        String coverHref = "";
        String navHref = "";
        NodeList items = opf.getElementsByTagNameNS("*", "item");
        for (int i = 0; i < items.getLength(); i++) {
            Element element = (Element) items.item(i);
            manifest.put(element.getAttribute("id"), element.getAttribute("href"));
            if (element.getAttribute("properties").contains("cover-image")) coverHref = element.getAttribute("href");
            if (element.getAttribute("properties").contains("nav")) navHref = element.getAttribute("href");
        }
        if (coverHref.isEmpty()) {
            NodeList metas = opf.getElementsByTagNameNS("*", "meta");
            for (int i = 0; i < metas.getLength(); i++) {
                Element meta = (Element) metas.item(i);
                if ("cover".equalsIgnoreCase(meta.getAttribute("name"))) {
                    String candidate = manifest.get(meta.getAttribute("content"));
                    if (candidate != null) coverHref = candidate;
                }
            }
        }
        if (coverHref.isEmpty()) {
            for (int i = 0; i < items.getLength(); i++) {
                Element item = (Element) items.item(i);
                String idAndHref = (item.getAttribute("id") + " " + item.getAttribute("href")).toLowerCase(Locale.ROOT);
                if (item.getAttribute("media-type").startsWith("image/")
                        && (idAndHref.contains("cover") || idAndHref.contains("front") || idAndHref.contains("titlepage"))) {
                    coverHref = item.getAttribute("href");
                    break;
                }
            }
        }
        String opfDir = parentPath(opfPath);
        String coverPath = "";
        if (!coverHref.isEmpty()) {
            String candidate = resolvePath(opfDir, coverHref);
            if (isUsableCover(target, candidate)) coverPath = candidate;
        }
        if (coverPath.isEmpty()) {
            NodeList guideRefs = opf.getElementsByTagNameNS("*", "reference");
            for (int i = 0; i < guideRefs.getLength() && coverPath.isEmpty(); i++) {
                Element ref = (Element) guideRefs.item(i);
                if (!ref.getAttribute("type").toLowerCase(Locale.ROOT).contains("cover")) continue;
                String guidePath = resolvePath(opfDir, ref.getAttribute("href"));
                if (isUsableCover(target, guidePath)) coverPath = guidePath;
                else coverPath = coverFromHtml(target, guidePath);
            }
        }
        List<TocEntry> tocEntries = new ArrayList<>();
        if (!navHref.isEmpty()) collectNavEntries(target, resolvePath(opfDir, navHref), tocEntries);
        NodeList spineNodes = opf.getElementsByTagNameNS("*", "spine");
        if (spineNodes.getLength() > 0) {
            String ncxHref = manifest.get(((Element) spineNodes.item(0)).getAttribute("toc"));
            if (ncxHref != null && !ncxHref.isEmpty()) collectNcxEntries(target, resolvePath(opfDir, ncxHref), tocEntries);
        }
        List<String> spinePaths = new ArrayList<>();
        NodeList refs = opf.getElementsByTagNameNS("*", "itemref");
        for (int i = 0; i < refs.getLength(); i++) {
            String href = manifest.get(((Element) refs.item(i)).getAttribute("idref"));
            if (href != null && !href.isEmpty()) spinePaths.add(resolvePath(opfDir, href));
        }
        if (spinePaths.isEmpty()) throw new IllegalArgumentException("EPUB 没有可阅读章节");

        List<String> finalPaths = new ArrayList<>();
        List<String> finalTitles = new ArrayList<>();
        List<Integer> finalDepths = new ArrayList<>();
        if (tocEntries.isEmpty()) {
            finalPaths.addAll(spinePaths);
        } else {
            Map<String, List<TocEntry>> entriesByPath = new LinkedHashMap<>();
            for (TocEntry entry : tocEntries) entriesByPath.computeIfAbsent(entry.path, ignored -> new ArrayList<>()).add(entry);
            for (String spinePath : spinePaths) {
                List<TocEntry> entries = entriesByPath.get(spinePath);
                if (entries == null || entries.isEmpty()) continue;
                appendAnchoredSections(target, spinePath, entries, finalPaths, finalTitles, finalDepths);
            }
            if (finalPaths.isEmpty()) finalPaths.addAll(spinePaths);
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            upsertBook(db, id, title, "epub", author, coverPath, displayName, source.length(), finalPaths.size());
            db.delete("chapters", "book_id=?", new String[]{id});
            for (int i = 0; i < finalPaths.size(); i++) {
                String path = finalPaths.get(i);
                File chapter = safeFile(target, path);
                String chapterTitle = i < finalTitles.size() ? finalTitles.get(i) : null;
                if (chapterTitle == null || chapterTitle.isEmpty()) chapterTitle = extractHtmlTitle(chapter, "第 " + (i + 1) + " 章");
                insertChapter(db, id, i, chapterTitle, path, i < finalDepths.size() ? finalDepths.get(i) : 0);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized JSONArray listBooks() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,title,type,author,cover_path,added,last_opened,progress,current_chapter,chapter_count,original_name,file_size,category,tags,description,EXISTS(SELECT 1 FROM analysis_cache a WHERE a.book_id=books.id) FROM books WHERE deleted=0 ORDER BY CASE WHEN last_opened=0 THEN added ELSE last_opened END DESC", null)) {
            while (c.moveToNext()) result.put(bookJson(c));
        }
        return result;
    }

    synchronized JSONObject getBook(String id) throws Exception {
        requireBookId(id);
        ensureCurrentEpub(id);
        JSONObject book;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,title,type,author,cover_path,added,last_opened,progress,current_chapter,chapter_count,original_name,file_size,category,tags,description,EXISTS(SELECT 1 FROM analysis_cache a WHERE a.book_id=books.id) FROM books WHERE id=? AND deleted=0", new String[]{id})) {
            if (!c.moveToFirst()) throw new IllegalArgumentException("书籍不存在");
            book = bookJson(c);
        }
        JSONArray chapters = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT idx,title,path,depth FROM chapters WHERE book_id=? ORDER BY idx", new String[]{id})) {
            while (c.moveToNext()) chapters.put(new JSONObject().put("index", c.getInt(0)).put("title", c.getString(1)).put("path", c.getString(2)).put("depth", c.getInt(3)));
        }
        if (chapters.length() == 0) throw new IllegalStateException("书籍原文尚未同步，请在电脑服务器开启后点击立即同步");
        book.put("chapters", chapters);
        getWritableDatabase().execSQL("UPDATE books SET last_opened=? WHERE id=?", new Object[]{System.currentTimeMillis(), id});
        return book;
    }

    private void markParserCurrent(String id) {
        getWritableDatabase().execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES(?,?,?)", new Object[]{"epub_parser." + id, EPUB_PARSER_REVISION, System.currentTimeMillis()});
    }

    private void ensureCurrentEpub(String id) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        String type = "";
        try (Cursor c = db.rawQuery("SELECT type FROM books WHERE id=? AND deleted=0", new String[]{id})) {
            if (c.moveToFirst()) type = c.getString(0);
        }
        if (!"epub".equals(type)) return;
        try (Cursor c = db.rawQuery("SELECT value FROM app_state WHERE key=?", new String[]{"epub_parser." + id})) {
            if (c.moveToFirst() && EPUB_PARSER_REVISION.equals(c.getString(0))) return;
        }
        File root = new File(booksDir, id);
        File original = new File(root, "original.epub");
        if (!original.isFile()) { markParserCurrent(id); return; }

        double progress = 0;
        int oldChapter = 0;
        long added = System.currentTimeMillis(), lastOpened = 0;
        String oldTitle = "";
        String originalName = "book.epub";
        try (Cursor c = db.rawQuery("SELECT b.progress,b.current_chapter,b.added,b.last_opened,b.original_name,COALESCE(ch.title,'') FROM books b LEFT JOIN chapters ch ON ch.book_id=b.id AND ch.idx=b.current_chapter WHERE b.id=?", new String[]{id})) {
            if (c.moveToFirst()) {
                progress = c.getDouble(0); oldChapter = c.getInt(1); added = c.getLong(2);
                lastOpened = c.getLong(3); originalName = c.getString(4); oldTitle = c.getString(5);
            }
        }
        importEpub(original, root, id, originalName);
        int restoredChapter = oldChapter;
        if (!oldTitle.isEmpty()) {
            try (Cursor c = db.rawQuery("SELECT idx FROM chapters WHERE book_id=? AND title=? ORDER BY idx LIMIT 1", new String[]{id, oldTitle})) {
                if (c.moveToFirst()) restoredChapter = c.getInt(0);
            }
        }
        int chapterCount = 1;
        try (Cursor c = db.rawQuery("SELECT chapter_count FROM books WHERE id=?", new String[]{id})) { if (c.moveToFirst()) chapterCount = Math.max(1, c.getInt(0)); }
        db.execSQL("UPDATE books SET progress=?,current_chapter=?,added=?,last_opened=? WHERE id=?", new Object[]{progress, Math.min(restoredChapter, chapterCount - 1), added, lastOpened, id});
        markParserCurrent(id);
    }

    synchronized JSONObject getChapter(String bookId, int index) throws Exception {
        requireBookId(bookId);
        String path;
        String title;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT title,path FROM chapters WHERE book_id=? AND idx=?", new String[]{bookId, String.valueOf(index)})) {
            if (!c.moveToFirst()) throw new IllegalArgumentException("章节不存在");
            title = c.getString(0); path = c.getString(1);
        }
        File file = safeFile(new File(booksDir, bookId), path);
        String html = decodeText(readAll(new FileInputStream(file)));
        html = sanitizeHtml(html);
        String base = "https://app.local/content/" + bookId + "/" + parentPath(path);
        return new JSONObject().put("title", title).put("html", html).put("base", base);
    }

    synchronized JSONArray searchBooks(String query, String onlyBookId, int limit) throws Exception {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (needle.isEmpty() || needle.length() > 100) throw new IllegalArgumentException("请输入 1–100 个字符进行搜索");
        JSONArray result = new JSONArray(); int maximum = Math.max(1, Math.min(100, limit));
        String sql = "SELECT c.book_id,b.title,c.idx,c.title,c.path FROM chapters c JOIN books b ON b.id=c.book_id WHERE b.deleted=0" + (onlyBookId == null || onlyBookId.isEmpty() ? "" : " AND c.book_id=?") + " ORDER BY b.last_opened DESC,c.idx";
        String[] args = onlyBookId == null || onlyBookId.isEmpty() ? null : new String[]{onlyBookId};
        try (Cursor c = getReadableDatabase().rawQuery(sql, args)) {
            while (c.moveToNext() && result.length() < maximum) {
                File file = safeFile(new File(booksDir, c.getString(0)), c.getString(4));
                String text = decodeText(readAll(new FileInputStream(file))).replaceAll("(?is)<script.*?</script>|<style.*?</style>|<[^>]+>", " ").replaceAll("\\s+", " ").trim();
                String folded = text.toLowerCase(Locale.ROOT); int from = 0, found;
                while (result.length() < maximum && (found = folded.indexOf(needle, from)) >= 0) {
                    int left = Math.max(0, found - 42), right = Math.min(text.length(), found + query.length() + 68);
                    result.put(new JSONObject().put("bookId", c.getString(0)).put("bookTitle", c.getString(1)).put("chapter", c.getInt(2)).put("chapterTitle", c.getString(3)).put("snippet", (left > 0 ? "…" : "") + text.substring(left, right) + (right < text.length() ? "…" : "")));
                    from = found + Math.max(1, needle.length());
                }
            }
        }
        return result;
    }

    synchronized JSONObject updateBookMetadata(String id, String json) throws Exception {
        requireBookId(id); JSONObject input = new JSONObject(json); long now = System.currentTimeMillis();
        String title = compact(input.optString("title"), 160), author = compact(input.optString("author"), 120), category = compact(input.optString("category", "未分类"), 40), description = compact(input.optString("description"), 1000);
        if (title.isEmpty()) throw new IllegalArgumentException("书名不能为空"); if (category.isEmpty()) category = "未分类";
        JSONArray raw = input.optJSONArray("tags"); JSONArray tags = new JSONArray(); java.util.HashSet<String> seen = new java.util.HashSet<>();
        if (raw != null) for (int i = 0; i < raw.length() && tags.length() < 12; i++) { String tag = compact(raw.optString(i), 24); if (!tag.isEmpty() && seen.add(tag)) tags.put(tag); }
        SQLiteDatabase db = getWritableDatabase(); db.execSQL("UPDATE books SET title=?,author=?,category=?,tags=?,description=?,updated=? WHERE id=? AND deleted=0", new Object[]{title,author,category,tags.toString(),description,now,id});
        JSONObject payload = new JSONObject().put("id",id).put("bookId",id).put("title",title).put("author",author).put("category",category).put("tags",tags).put("description",description).put("updatedAt",now);
        recordChange(db, "book_meta", id, "upsert", payload.toString(), now); return getBook(id);
    }

    private static String compact(String value, int maximum) { String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim(); return clean.length() > maximum ? clean.substring(0, maximum) : clean; }

    synchronized void updateProgress(String id, int chapter, double progress) {
        requireBookId(id);
        long now = System.currentTimeMillis();
        double safeProgress = Math.max(0, Math.min(1, progress));
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("UPDATE books SET current_chapter=?,progress=?,last_opened=?,updated=? WHERE id=?", new Object[]{chapter, safeProgress, now, now, id});
        try {
            JSONObject payload = new JSONObject().put("bookId", id).put("chapter", chapter).put("progress", safeProgress).put("updatedAt", now);
            db.delete("sync_outbox", "entity_type='progress' AND entity_id=?", new String[]{id});
            recordChange(db, "progress", id, "upsert", payload.toString(), now);
        } catch (Exception ignored) {}
    }

    synchronized JSONArray annotations(String bookId) throws Exception {
        requireBookId(bookId);
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,chapter,quote,note,color,created,updated,start_offset,end_offset,prefix,suffix FROM annotations WHERE book_id=? AND deleted=0 ORDER BY chapter,created", new String[]{bookId})) {
            while (c.moveToNext()) result.put(new JSONObject().put("id", c.getString(0)).put("chapter", c.getInt(1)).put("quote", c.getString(2)).put("note", c.getString(3)).put("color", c.getString(4)).put("created", c.getLong(5)).put("updated", c.getLong(6)).put("start", c.getInt(7)).put("end", c.getInt(8)).put("prefix", c.getString(9)).put("suffix", c.getString(10)));
        }
        return result;
    }

    synchronized JSONObject saveAnnotation(String bookId, String json) throws Exception {
        requireBookId(bookId);
        JSONObject input = new JSONObject(json);
        String id = input.optString("id", "").trim();
        if (id.isEmpty()) id = UUID.randomUUID().toString();
        int chapter = Math.max(0, input.optInt("chapter", 0));
        String quote = input.optString("quote", "").trim();
        String note = input.optString("note", "").trim();
        String color = input.optString("color", "amber").replaceAll("[^a-z]", "");
        int start = Math.max(-1, input.optInt("start", -1));
        int end = Math.max(start, input.optInt("end", start < 0 ? -1 : start + quote.length()));
        String prefix = input.optString("prefix", "");
        String suffix = input.optString("suffix", "");
        if (prefix.length() > 80) prefix = prefix.substring(prefix.length() - 80);
        if (suffix.length() > 80) suffix = suffix.substring(0, 80);
        if (quote.isEmpty() || quote.length() > 4000 || note.length() > 8000) throw new IllegalArgumentException("批注内容无效");
        long now = System.currentTimeMillis(), created = input.optLong("created", now);
        JSONObject output = new JSONObject().put("id", id).put("bookId", bookId).put("chapter", chapter).put("quote", quote).put("note", note).put("color", color).put("created", created).put("updated", now).put("start", start).put("end", end).put("prefix", prefix).put("suffix", suffix);
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("INSERT OR REPLACE INTO annotations(id,book_id,chapter,quote,note,color,created,updated,deleted,start_offset,end_offset,prefix,suffix) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)", new Object[]{id, bookId, chapter, quote, note, color, created, now, start, end, prefix, suffix});
        recordChange(db, "annotation", id, "upsert", output.toString(), now);
        return output;
    }

    synchronized void deleteAnnotation(String id) {
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("UPDATE annotations SET deleted=1,updated=? WHERE id=?", new Object[]{now, id});
        recordChange(db, "annotation", id, "delete", "{}", now);
    }

    synchronized JSONArray bookmarks(String bookId) throws Exception {
        requireBookId(bookId);
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,chapter,position,label,created,updated FROM bookmarks WHERE book_id=? AND deleted=0 ORDER BY chapter,position", new String[]{bookId})) {
            while (c.moveToNext()) result.put(new JSONObject().put("id", c.getString(0)).put("chapter", c.getInt(1)).put("position", c.getDouble(2)).put("label", c.getString(3)).put("created", c.getLong(4)).put("updated", c.getLong(5)));
        }
        return result;
    }

    synchronized JSONObject toggleBookmark(String bookId, int chapter, double position, String label) throws Exception {
        requireBookId(bookId);
        SQLiteDatabase db = getWritableDatabase();
        String existing = "";
        try (Cursor c = db.rawQuery("SELECT id FROM bookmarks WHERE book_id=? AND chapter=? AND deleted=0 LIMIT 1", new String[]{bookId, String.valueOf(chapter)})) { if (c.moveToFirst()) existing = c.getString(0); }
        long now = System.currentTimeMillis();
        if (!existing.isEmpty()) {
            db.execSQL("UPDATE bookmarks SET deleted=1,updated=? WHERE id=?", new Object[]{now, existing});
            recordChange(db, "bookmark", existing, "delete", "{}", now);
            return new JSONObject().put("active", false).put("id", existing);
        }
        String id = UUID.randomUUID().toString();
        JSONObject output = new JSONObject().put("id", id).put("bookId", bookId).put("chapter", chapter).put("position", position).put("label", label).put("created", now).put("updated", now);
        db.execSQL("INSERT INTO bookmarks(id,book_id,chapter,position,label,created,updated,deleted) VALUES(?,?,?,?,?,?,?,0)", new Object[]{id, bookId, chapter, position, label, now, now});
        recordChange(db, "bookmark", id, "upsert", output.toString(), now);
        return output.put("active", true);
    }

    synchronized JSONObject loadAnalysis(String bookId) throws Exception {
        requireBookId(bookId);
        try (Cursor c = getReadableDatabase().rawQuery("SELECT json,provider,model,updated,revision FROM analysis_cache WHERE book_id=?", new String[]{bookId})) {
            if (!c.moveToFirst()) return new JSONObject();
            return new JSONObject().put("analysis", new JSONObject(c.getString(0))).put("provider", c.getString(1)).put("model", c.getString(2)).put("updated", c.getLong(3)).put("revision", c.getInt(4));
        }
    }

    synchronized void saveAnalysis(String bookId, JSONObject analysis, String provider, String model, boolean revision) throws Exception {
        requireBookId(bookId);
        SQLiteDatabase db = getWritableDatabase();
        int count = revision ? 1 : 0;
        if (revision) try (Cursor c = db.rawQuery("SELECT revision FROM analysis_cache WHERE book_id=?", new String[]{bookId})) { if (c.moveToFirst()) count = c.getInt(0) + 1; }
        long now = System.currentTimeMillis();
        db.execSQL("INSERT OR REPLACE INTO analysis_cache(book_id,json,provider,model,updated,revision) VALUES(?,?,?,?,?,?)", new Object[]{bookId, analysis.toString(), provider, model, now, count});
        JSONObject payload = new JSONObject().put("bookId", bookId).put("analysis", analysis).put("provider", provider).put("model", model).put("updatedAt", now).put("revision", count);
        recordChange(db, "analysis", bookId, "upsert", payload.toString(), now);
    }

    synchronized String chunkNote(String cacheKey) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT note FROM analysis_chunks WHERE cache_key=?", new String[]{cacheKey})) { return c.moveToFirst() ? c.getString(0) : ""; }
    }

    synchronized void saveChunkNote(String cacheKey, String bookId, String note, String provider, String model) {
        requireBookId(bookId); SQLiteDatabase db = getWritableDatabase();
        db.execSQL("INSERT OR REPLACE INTO analysis_chunks(cache_key,book_id,note,provider,model,updated) VALUES(?,?,?,?,?,?)", new Object[]{cacheKey, bookId, note, provider, model, System.currentTimeMillis()});
        db.execSQL("DELETE FROM analysis_chunks WHERE cache_key IN (SELECT cache_key FROM analysis_chunks ORDER BY updated DESC LIMIT -1 OFFSET 500)");
    }

    synchronized String state(String key, String fallback) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT value FROM app_state WHERE key=?", new String[]{key})) { return c.moveToFirst() ? c.getString(0) : fallback; }
    }

    synchronized JSONObject statesWithPrefix(String prefix) throws Exception {
        JSONObject values = new JSONObject();
        if (prefix == null || prefix.length() < 3 || prefix.length() > 80) return values;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT key,value FROM app_state WHERE key GLOB ? ORDER BY updated DESC", new String[]{prefix + "*"})) {
            while (c.moveToNext()) values.put(c.getString(0), c.getString(1));
        }
        return values;
    }

    synchronized void saveState(String key, String value) {
        if (!key.matches("[a-zA-Z0-9_.-]{1,80}") || value.length() > 2_000_000) throw new IllegalArgumentException("设置内容无效");
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES(?,?,?)", new Object[]{key, value, now});
        try { recordChange(db, "app_state", key, "upsert", new JSONObject().put("key", key).put("value", value).put("updatedAt", now).toString(), now); }
        catch (Exception ignored) {}
    }

    synchronized void saveTranslationCache(String key, String value) {
        if (key == null || !key.matches("tr-v1-[a-f0-9]{64}") || value == null || value.length() > 100_000)
            throw new IllegalArgumentException("翻译缓存内容无效");
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES(?,?,?)", new Object[]{key, value, System.currentTimeMillis()});
        db.execSQL("DELETE FROM app_state WHERE key IN (SELECT key FROM app_state WHERE key LIKE 'tr-v1-%' ORDER BY updated DESC LIMIT -1 OFFSET 500)");
    }

    synchronized void recordReading(String bookId, long seconds, long chars, int completed) {
        requireBookId(bookId);
        if (seconds <= 0 && chars <= 0 && completed <= 0) return;
        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date());
        SQLiteDatabase db = getWritableDatabase();
        String source = localSourceId(db);
        long now = System.currentTimeMillis();
        db.execSQL("INSERT OR IGNORE INTO reading_contributions(day,book_id,source_id,seconds,chars,completed,updated,deleted) VALUES(?,?,?,0,0,0,?,0)", new Object[]{day, bookId, source, now});
        db.execSQL("UPDATE reading_contributions SET seconds=seconds+?,chars=chars+?,completed=MAX(completed,?),updated=?,deleted=0 WHERE day=? AND book_id=? AND source_id=?", new Object[]{Math.min(seconds, 3600), Math.max(0, chars), Math.max(0, completed), now, day, bookId, source});
        refreshReadingAggregate(db, day, bookId);
        try (Cursor c = db.rawQuery("SELECT seconds,chars,completed FROM reading_contributions WHERE day=? AND book_id=? AND source_id=?", new String[]{day, bookId, source})) {
            if (c.moveToFirst()) {
                JSONObject payload = new JSONObject().put("day", day).put("bookId", bookId).put("seconds", c.getLong(0))
                        .put("chars", c.getLong(1)).put("completed", c.getInt(2)).put("sourceId", source).put("updatedAt", now);
                String entityId = day + "::" + bookId + "::" + source;
                db.delete("sync_outbox", "entity_type='reading_daily' AND entity_id=?", new String[]{entityId});
                recordChange(db, "reading_daily", entityId, "upsert", payload.toString(), now);
            }
        } catch (Exception ignored) {}
    }

    private static String localSourceId(SQLiteDatabase db) {
        try (Cursor c = db.rawQuery("SELECT value FROM app_state WHERE key='sync.local_source_id'", null)) {
            if (c.moveToFirst() && !c.getString(0).isEmpty()) return c.getString(0);
        }
        String value = "android-" + UUID.randomUUID();
        db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES('sync.local_source_id',?,?)", new Object[]{value, System.currentTimeMillis()});
        return value;
    }

    private static void refreshReadingAggregate(SQLiteDatabase db, String day, String bookId) {
        db.execSQL("INSERT INTO reading_daily(day,book_id,seconds,chars,completed) SELECT ?,?,COALESCE(SUM(seconds),0),COALESCE(SUM(chars),0),COALESCE(MAX(completed),0) FROM reading_contributions WHERE day=? AND book_id=? AND deleted=0 ON CONFLICT(day,book_id) DO UPDATE SET seconds=excluded.seconds,chars=excluded.chars,completed=excluded.completed", new Object[]{day, bookId, day, bookId});
    }

    synchronized JSONArray readingStats() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT r.day,r.book_id,b.title,r.seconds,r.chars,r.completed FROM reading_daily r LEFT JOIN books b ON b.id=r.book_id ORDER BY r.day DESC", null)) {
            while (c.moveToNext()) result.put(new JSONObject().put("day", c.getString(0)).put("bookId", c.getString(1)).put("title", c.getString(2)).put("seconds", c.getLong(3)).put("chars", c.getLong(4)).put("completed", c.getInt(5)));
        }
        return result;
    }

    synchronized String searchableText(String bookId, int maxChars) throws Exception {
        requireBookId(bookId);
        StringBuilder out = new StringBuilder(); int chapterCount = 1;
        try (Cursor count = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM chapters WHERE book_id=?", new String[]{bookId})) { if (count.moveToFirst()) chapterCount = Math.max(1, count.getInt(0)); }
        int perChapter = Math.max(1200, maxChars / chapterCount);
        try (Cursor c = getReadableDatabase().rawQuery("SELECT title,path FROM chapters WHERE book_id=? ORDER BY idx", new String[]{bookId})) {
            while (c.moveToNext()) {
                File file = safeFile(new File(booksDir, bookId), c.getString(1));
                String text = decodeText(readAll(new FileInputStream(file))).replaceAll("(?is)<(style|script)[^>]*>.*?</\\1>", " ").replaceAll("(?s)<[^>]+>", " ").replaceAll("&nbsp;", " ").replaceAll("\\s+", " ").trim();
                out.append("\n## ").append(c.getString(0)).append("\n").append(uniformSample(text, perChapter));
            }
        }
        return out.length() > maxChars ? out.substring(0, maxChars) : out.toString();
    }

    private static String uniformSample(String text, int budget) {
        if (text.length() <= budget) return text; int slices = 5, slice = Math.max(1, budget / slices); StringBuilder out = new StringBuilder(budget);
        for (int i = 0; i < slices; i++) { int start = Math.min(text.length() - slice, Math.round((text.length() - slice) * (i / (float)(slices - 1)))); if (i > 0) out.append(" … "); out.append(text, start, Math.min(text.length(), start + slice)); }
        return out.toString();
    }

    synchronized JSONObject syncChanges(long after, int limit) throws Exception {
        JSONArray changes = new JSONArray(); long cursor = after;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT seq,change_id,entity_type,entity_id,operation,payload,created FROM sync_outbox WHERE seq>? ORDER BY seq LIMIT ?", new String[]{String.valueOf(after), String.valueOf(Math.max(1, Math.min(500, limit))) })) {
            while (c.moveToNext()) { cursor = c.getLong(0); changes.put(new JSONObject().put("cursor", cursor).put("changeId", c.getString(1)).put("entityType", c.getString(2)).put("entityId", c.getString(3)).put("operation", c.getString(4)).put("payload", new JSONObject(c.getString(5))).put("createdAt", c.getLong(6))); }
        }
        return new JSONObject().put("protocol", "yuejian-sync-v1").put("cursor", cursor).put("changes", changes).put("hasMore", changes.length() >= limit);
    }

    synchronized int acknowledgeSync(long cursor) {
        if (cursor <= 0) return 0;
        return getWritableDatabase().delete("sync_outbox", "seq<=?", new String[]{String.valueOf(cursor)});
    }

    synchronized int pendingSyncCount() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM sync_outbox", null)) { return c.moveToFirst() ? c.getInt(0) : 0; }
    }

    synchronized int pendingBlobCount() {
        int count = 0;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,type FROM books WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                File original = new File(new File(booksDir, c.getString(0)), "epub".equals(c.getString(1)) ? "original.epub" : "original.txt");
                if (!original.isFile()) count++;
            }
        }
        return count;
    }

    synchronized JSONObject queueFullSyncSnapshot() throws Exception {
        SQLiteDatabase db = getWritableDatabase(); long now = System.currentTimeMillis();
        int books = 0, annotations = 0, bookmarks = 0, readingDays = 0, analyses = 0, settings = 0;
        try (Cursor c = db.rawQuery("SELECT id,title,type,author,original_name,file_size,chapter_count,current_chapter,progress,updated FROM books WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                String id = c.getString(0); long updated = Math.max(now, c.getLong(9));
                JSONObject book = new JSONObject().put("id", id).put("bookId", id).put("title", c.getString(1)).put("type", c.getString(2))
                        .put("author", c.getString(3)).put("originalName", c.getString(4)).put("fileSize", c.getLong(5))
                        .put("chapterCount", c.getInt(6)).put("blobSha256", id).put("updatedAt", updated);
                recordChange(db, "book", id, "upsert", book.toString(), updated);
                JSONObject progress = new JSONObject().put("bookId", id).put("chapter", c.getInt(7)).put("progress", c.getDouble(8)).put("updatedAt", updated);
                recordChange(db, "progress", id, "upsert", progress.toString(), updated); books++;
            }
        }
        try (Cursor c = db.rawQuery("SELECT id,book_id,chapter,quote,note,color,created,updated,start_offset,end_offset,prefix,suffix FROM annotations WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                JSONObject item = new JSONObject().put("bookId", c.getString(1)).put("chapter", c.getInt(2)).put("quote", c.getString(3)).put("note", c.getString(4))
                        .put("color", c.getString(5)).put("created", c.getLong(6)).put("updatedAt", c.getLong(7)).put("start", c.getInt(8)).put("end", c.getInt(9)).put("prefix", c.getString(10)).put("suffix", c.getString(11));
                recordChange(db, "annotation", c.getString(0), "upsert", item.toString(), Math.max(now, c.getLong(7))); annotations++;
            }
        }
        try (Cursor c = db.rawQuery("SELECT id,book_id,chapter,position,label,created,updated FROM bookmarks WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                JSONObject item = new JSONObject().put("bookId", c.getString(1)).put("chapter", c.getInt(2)).put("position", c.getDouble(3)).put("label", c.getString(4)).put("created", c.getLong(5)).put("updatedAt", c.getLong(6));
                recordChange(db, "bookmark", c.getString(0), "upsert", item.toString(), Math.max(now, c.getLong(6))); bookmarks++;
            }
        }
        try (Cursor c = db.rawQuery("SELECT day,book_id,source_id,seconds,chars,completed,updated,deleted FROM reading_contributions", null)) {
            while (c.moveToNext()) {
                JSONObject item = new JSONObject().put("day", c.getString(0)).put("bookId", c.getString(1)).put("sourceId", c.getString(2)).put("seconds", c.getLong(3)).put("chars", c.getLong(4)).put("completed", c.getInt(5)).put("updatedAt", c.getLong(6));
                recordChange(db, "reading_daily", c.getString(0) + "::" + c.getString(1) + "::" + c.getString(2), c.getInt(7) == 1 ? "delete" : "upsert", item.toString(), Math.max(now, c.getLong(6))); readingDays++;
            }
        }
        try (Cursor c = db.rawQuery("SELECT book_id,json,provider,model,updated,revision FROM analysis_cache", null)) {
            while (c.moveToNext()) {
                JSONObject item = new JSONObject().put("bookId", c.getString(0)).put("analysis", new JSONObject(c.getString(1))).put("provider", c.getString(2)).put("model", c.getString(3)).put("updatedAt", c.getLong(4)).put("revision", c.getInt(5));
                recordChange(db, "analysis", c.getString(0), "upsert", item.toString(), c.getLong(4)); analyses++;
            }
        }
        try (Cursor c = db.rawQuery("SELECT key,value,updated FROM app_state WHERE key NOT LIKE 'epub_parser.%'", null)) {
            while (c.moveToNext()) {
                String key = c.getString(0), lowered = key.toLowerCase(Locale.ROOT);
                if (lowered.contains("token") || lowered.contains("cookie") || lowered.contains("api_key") || lowered.contains("protected_key")) continue;
                JSONObject item = new JSONObject().put("key", key).put("value", c.getString(1)).put("updatedAt", Math.max(now, c.getLong(2)));
                recordChange(db, "app_state", key, "upsert", item.toString(), Math.max(now, c.getLong(2))); settings++;
            }
        }
        return new JSONObject().put("books", books).put("annotations", annotations).put("bookmarks", bookmarks).put("readingDays", readingDays).put("analyses", analyses).put("settings", settings);
    }

    synchronized JSONArray syncableBookBlobs() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,type,original_name FROM books WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                String id = c.getString(0), type = c.getString(1);
                File original = new File(new File(booksDir, id), "epub".equals(type) ? "original.epub" : "original.txt");
                if (original.isFile() && original.length() <= 30L * 1024 * 1024) {
                    result.put(new JSONObject().put("id", id).put("type", type).put("originalName", c.getString(2))
                            .put("path", original.getAbsolutePath()).put("size", original.length()));
                }
            }
        }
        return result;
    }

    synchronized JSONArray missingBookBlobs() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,type,original_name FROM books WHERE deleted=0", null)) {
            while (c.moveToNext()) {
                String id = c.getString(0), type = c.getString(1);
                File original = new File(new File(booksDir, id), "epub".equals(type) ? "original.epub" : "original.txt");
                if (!original.isFile()) result.put(new JSONObject().put("id", id).put("type", type).put("originalName", c.getString(2)));
            }
        }
        return result;
    }

    synchronized JSONObject importSyncedBlob(File temporary, JSONObject metadata) throws Exception {
        String id = metadata.optString("id"), type = metadata.optString("type", "epub");
        requireBookId(id);
        String originalName = metadata.optString("originalName");
        if (originalName.isEmpty()) originalName = metadata.optString("title", "同步书籍") + ("txt".equals(type) ? ".txt" : ".epub");
        if (!(originalName.toLowerCase(Locale.ROOT).endsWith(".epub") || originalName.toLowerCase(Locale.ROOT).endsWith(".txt")))
            originalName += "txt".equals(type) ? ".txt" : ".epub";
        JSONObject imported = importDownloaded(temporary, originalName);
        if (!id.equals(imported.optString("id"))) throw new IllegalStateException("同步书籍哈希校验失败");
        return imported;
    }

    File createSyncTemporary() throws Exception { return File.createTempFile("sync-book-", ".part", context.getCacheDir()); }

    synchronized void applyRemoteChange(JSONObject change) throws Exception {
        String type = change.optString("entityType"), id = change.optString("entityId"), operation = change.optString("operation");
        JSONObject payload = change.optJSONObject("payload"); if (payload == null) payload = new JSONObject();
        long updated = Math.max(0, payload.optLong("updatedAt", payload.optLong("updated", change.optLong("createdAt", 0))));
        SQLiteDatabase db = getWritableDatabase();
        if ("progress".equals(type)) {
            String bookId = payload.optString("bookId", id);
            long local = rowLong(db, "SELECT updated FROM books WHERE id=?", bookId);
            if (updated >= local) db.execSQL("UPDATE books SET current_chapter=?,progress=?,last_opened=?,updated=? WHERE id=?", new Object[]{Math.max(0, payload.optInt("chapter")), Math.max(0, Math.min(1, payload.optDouble("progress"))), updated, updated, bookId});
            return;
        }
        if ("annotation".equals(type) || "reader_mark".equals(type)) {
            if ("delete".equals(operation)) { db.execSQL("UPDATE annotations SET deleted=1,updated=MAX(updated,?) WHERE id=?", new Object[]{updated, id}); return; }
            long local = rowLong(db, "SELECT updated FROM annotations WHERE id=?", id); if (updated < local) return;
            String bookId = payload.optString("bookId", payload.optString("book", "")); if (bookId.isEmpty()) return;
            db.execSQL("INSERT OR REPLACE INTO annotations(id,book_id,chapter,quote,note,color,created,updated,deleted,start_offset,end_offset,prefix,suffix) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)",
                    new Object[]{id, bookId, Math.max(0, payload.optInt("chapter")), payload.optString("quote"), payload.optString("note"), payload.optString("color", "amber"), payload.optLong("created", updated), updated, payload.optInt("start", -1), payload.optInt("end", -1), payload.optString("prefix"), payload.optString("suffix")});
            return;
        }
        if ("bookmark".equals(type)) {
            if ("delete".equals(operation)) { db.execSQL("UPDATE bookmarks SET deleted=1,updated=MAX(updated,?) WHERE id=?", new Object[]{updated, id}); return; }
            long local = rowLong(db, "SELECT updated FROM bookmarks WHERE id=?", id); if (updated < local) return;
            String bookId = payload.optString("bookId"); if (bookId.isEmpty()) return;
            db.execSQL("INSERT OR REPLACE INTO bookmarks(id,book_id,chapter,position,label,created,updated,deleted) VALUES(?,?,?,?,?,?,?,0)",
                    new Object[]{id, bookId, Math.max(0, payload.optInt("chapter")), payload.optDouble("position"), payload.optString("label"), payload.optLong("created", updated), updated});
            return;
        }
        if ("reading_daily".equals(type)) {
            String day = payload.optString("day"), bookId = payload.optString("bookId"); if (day.isEmpty() || bookId.isEmpty()) return;
            String source = payload.optString("sourceId");
            if (source.isEmpty()) {
                String suffix = id.startsWith(day + "::" + bookId + "::") ? id.substring((day + "::" + bookId + "::").length()) : "legacy-remote";
                source = suffix.isEmpty() ? "legacy-remote" : suffix;
            }
            if (source.startsWith("legacy-") && "1".equals(state("sync.reading_legacy_migrated", "0"))) return;
            long local = -1;
            try (Cursor c = db.rawQuery("SELECT updated FROM reading_contributions WHERE day=? AND book_id=? AND source_id=?", new String[]{day, bookId, source})) { if (c.moveToFirst()) local = c.getLong(0); }
            if (updated < local) return;
            db.execSQL("INSERT OR REPLACE INTO reading_contributions(day,book_id,source_id,seconds,chars,completed,updated,deleted) VALUES(?,?,?,?,?,?,?,?)",
                    new Object[]{day, bookId, source, Math.max(0, payload.optLong("seconds")), Math.max(0, payload.optLong("chars")), Math.max(0, payload.optInt("completed")), updated, "delete".equals(operation) ? 1 : 0});
            refreshReadingAggregate(db, day, bookId);
            return;
        }
        if ("analysis".equals(type)) {
            if ("delete".equals(operation)) { db.delete("analysis_cache", "book_id=?", new String[]{id}); return; }
            JSONObject analysis = payload.optJSONObject("analysis"); if (analysis == null) return;
            long local = rowLong(db, "SELECT updated FROM analysis_cache WHERE book_id=?", id); if (updated < local) return;
            db.execSQL("INSERT OR REPLACE INTO analysis_cache(book_id,json,provider,model,updated,revision) VALUES(?,?,?,?,?,?)",
                    new Object[]{payload.optString("bookId", id), analysis.toString(), payload.optString("provider"), payload.optString("model"), updated, payload.optInt("revision")});
            return;
        }
        if ("book".equals(type) || "book_meta".equals(type)) {
            if ("delete".equals(operation)) {
                db.execSQL("UPDATE books SET deleted=1,updated=MAX(updated,?) WHERE id=?", new Object[]{updated, id});
                db.delete("chapters", "book_id=?", new String[]{id});
                db.delete("analysis_cache", "book_id=?", new String[]{id});
                db.delete("analysis_chunks", "book_id=?", new String[]{id});
                db.execSQL("UPDATE annotations SET deleted=1,updated=MAX(updated,?) WHERE book_id=?", new Object[]{updated, id});
                db.execSQL("UPDATE bookmarks SET deleted=1,updated=MAX(updated,?) WHERE book_id=?", new Object[]{updated, id});
                deleteTree(new File(booksDir, id));
                return;
            }
            long local = rowLong(db, "SELECT updated FROM books WHERE id=?", id); if (updated < local) return;
            db.execSQL("INSERT OR IGNORE INTO books(id,title,type,author,cover_path,original_name,file_size,added,last_opened,progress,current_chapter,chapter_count,updated,deleted) VALUES(?,?,?,?,?,?,?, ?,0,0,0,?,?,0)",
                    new Object[]{id, payload.optString("title", "未下载书籍"), payload.optString("type", "epub"), payload.optString("author"), "", payload.optString("originalName"), payload.optLong("fileSize"), payload.optLong("addedAt", updated), payload.optInt("chapterCount"), updated});
            db.execSQL("UPDATE books SET title=?,author=?,category=?,tags=?,description=?,original_name=CASE WHEN ?='' THEN original_name ELSE ? END,file_size=MAX(file_size,?),chapter_count=MAX(chapter_count,?),updated=?,deleted=0 WHERE id=?",
                    new Object[]{payload.optString("title", "未下载书籍"), payload.optString("author"), payload.optString("category", "未分类"), String.valueOf(payload.optJSONArray("tags") == null ? new JSONArray() : payload.optJSONArray("tags")), payload.optString("description"), payload.optString("originalName"), payload.optString("originalName"), payload.optLong("fileSize"), payload.optInt("chapterCount"), updated, id});
            return;
        }
        if ("app_state".equals(type)) applyRemoteState(db, payload.optString("key", id), payload.optString("value", ""), operation, updated);
    }

    private void applyRemoteState(SQLiteDatabase db, String key, String value, String operation, long updated) throws Exception {
        String lowered = key.toLowerCase(Locale.ROOT);
        if (key.isEmpty() || lowered.contains("token") || lowered.contains("cookie") || lowered.contains("local-path")
                || lowered.contains("local_path") || lowered.contains("protected_key") || lowered.contains("api-key") || lowered.contains("api_key")) return;
        if ("delete".equals(operation)) { db.delete("app_state", "key=?", new String[]{key}); return; }
        long local = rowLong(db, "SELECT updated FROM app_state WHERE key=?", key); if (updated < local) return;
        db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES(?,?,?)", new Object[]{key, value, updated});
        if ("yuejian-profile-name".equals(key) || "yuejian-profile-avatar".equals(key)) {
            JSONObject profile; try { profile = new JSONObject(state("profile", "{}")); } catch (Exception ignored) { profile = new JSONObject(); }
            if ("yuejian-profile-name".equals(key)) profile.put("name", value); else profile.put("avatar", value);
            db.execSQL("INSERT OR REPLACE INTO app_state(key,value,updated) VALUES('profile',?,?)", new Object[]{profile.toString(), updated});
        }
        if ("yuejian-reader-marks".equals(key)) {
            JSONArray marks; try { marks = new JSONArray(value); } catch (Exception ignored) { return; }
            for (int index = 0; index < marks.length(); index++) {
                JSONObject mark = marks.optJSONObject(index); if (mark == null) continue;
                JSONObject remote = new JSONObject().put("entityType", "reader_mark").put("entityId", mark.optString("id", UUID.randomUUID().toString()))
                        .put("operation", "upsert").put("payload", mark.put("updatedAt", mark.optLong("updated", updated)));
                applyRemoteChange(remote);
            }
        }
        if ("yuejian-book-progress".equals(key)) {
            JSONObject progress; try { progress = new JSONObject(value); } catch (Exception ignored) { return; }
            java.util.Iterator<String> ids = progress.keys();
            while (ids.hasNext()) {
                String bookId = ids.next(); JSONObject item = progress.optJSONObject(bookId); if (item == null) continue;
                JSONObject remote = new JSONObject().put("entityType", "progress").put("entityId", bookId).put("operation", "upsert")
                        .put("payload", item.put("bookId", bookId));
                applyRemoteChange(remote);
            }
        }
    }

    private static long rowLong(SQLiteDatabase db, String sql, String value) {
        try (Cursor c = db.rawQuery(sql, new String[]{value})) { return c.moveToFirst() ? c.getLong(0) : -1; }
    }

    synchronized JSONObject storageStatus() throws Exception {
        long books = directorySize(booksDir), database = context.getDatabasePath("yuejian.db").length();
        int bookCount = 0, analysisCount = 0, annotationCount = 0;
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM books WHERE deleted=0", null)) { if (c.moveToFirst()) bookCount = c.getInt(0); }
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM analysis_cache", null)) { if (c.moveToFirst()) analysisCount = c.getInt(0); }
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM annotations WHERE deleted=0", null)) { if (c.moveToFirst()) annotationCount = c.getInt(0); }
        return new JSONObject().put("totalBytes", books + database).put("bookBytes", books).put("databaseBytes", database).put("bookCount", bookCount).put("analysisCount", analysisCount).put("annotationCount", annotationCount);
    }

    synchronized int clearAnalysis(String bookId) {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        if (bookId == null || bookId.isEmpty()) {
            int count = 0;
            try (Cursor c = db.rawQuery("SELECT book_id FROM analysis_cache", null)) {
                while (c.moveToNext()) { recordChange(db, "analysis", c.getString(0), "delete", "{\"updatedAt\":" + now + "}", now); count++; }
            }
            db.delete("analysis_cache", null, null); db.delete("analysis_chunks", null, null); return count;
        }
        requireBookId(bookId); int count = db.delete("analysis_cache", "book_id=?", new String[]{bookId}); db.delete("analysis_chunks", "book_id=?", new String[]{bookId});
        if (count > 0) recordChange(db, "analysis", bookId, "delete", "{\"bookId\":\"" + bookId + "\",\"updatedAt\":" + now + "}", now);
        return count;
    }

    private static void recordChange(SQLiteDatabase db, String entityType, String entityId, String operation, String payload, long created) {
        db.execSQL("INSERT OR IGNORE INTO sync_outbox(change_id,entity_type,entity_id,operation,payload,created) VALUES(?,?,?,?,?,?)", new Object[]{UUID.randomUUID().toString(), entityType, entityId, operation, payload, created});
    }

    private static long directorySize(File file) {
        if (!file.exists()) return 0; if (file.isFile()) return file.length();
        long size = 0; File[] children = file.listFiles(); if (children != null) for (File child : children) size += directorySize(child); return size;
    }

    synchronized void deleteBook(String id) {
        requireBookId(id);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            try (Cursor c = db.rawQuery("SELECT id FROM annotations WHERE book_id=? AND deleted=0", new String[]{id})) {
                while (c.moveToNext()) recordChange(db, "annotation", c.getString(0), "delete", new JSONObject().put("bookId", id).put("updatedAt", now).toString(), now);
            } catch (Exception ignored) {}
            try (Cursor c = db.rawQuery("SELECT id FROM bookmarks WHERE book_id=? AND deleted=0", new String[]{id})) {
                while (c.moveToNext()) recordChange(db, "bookmark", c.getString(0), "delete", new JSONObject().put("bookId", id).put("updatedAt", now).toString(), now);
            } catch (Exception ignored) {}
            try (Cursor c = db.rawQuery("SELECT day,source_id,seconds,chars,completed FROM reading_contributions WHERE book_id=? AND deleted=0", new String[]{id})) {
                while (c.moveToNext()) {
                    String entityId = c.getString(0) + "::" + id + "::" + c.getString(1);
                    JSONObject payload = new JSONObject().put("day", c.getString(0)).put("bookId", id).put("sourceId", c.getString(1)).put("seconds", c.getLong(2)).put("chars", c.getLong(3)).put("completed", c.getInt(4)).put("updatedAt", now);
                    recordChange(db, "reading_daily", entityId, "delete", payload.toString(), now);
                }
            } catch (Exception ignored) {}
            db.delete("chapters", "book_id=?", new String[]{id});
            db.delete("analysis_cache", "book_id=?", new String[]{id});
            db.delete("analysis_chunks", "book_id=?", new String[]{id});
            try { recordChange(db, "analysis", id, "delete", new JSONObject().put("bookId", id).put("updatedAt", now).toString(), now); } catch (Exception ignored) {}
            db.execSQL("UPDATE annotations SET deleted=1,updated=? WHERE book_id=?", new Object[]{now, id});
            db.execSQL("UPDATE bookmarks SET deleted=1,updated=? WHERE book_id=?", new Object[]{now, id});
            db.execSQL("UPDATE reading_contributions SET deleted=1,updated=? WHERE book_id=?", new Object[]{now, id});
            db.delete("reading_daily", "book_id=?", new String[]{id});
            db.execSQL("UPDATE books SET deleted=1,updated=? WHERE id=?", new Object[]{now, id});
            try { recordChange(db, "book", id, "delete", new JSONObject().put("bookId", id).put("updatedAt", now).toString(), now); }
            catch (Exception ignored) { recordChange(db, "book", id, "delete", "{}", now); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        deleteTree(new File(booksDir, id));
    }

    byte[] resource(String bookId, String encodedPath) throws Exception {
        requireBookId(bookId);
        String path = URLDecoder.decode(encodedPath, "UTF-8");
        File resource = safeFile(new File(booksDir, bookId), path);
        if (resource.length() > 12L * 1024 * 1024) throw new IllegalArgumentException("书内资源超过 12MB 限制");
        return readAll(new FileInputStream(resource));
    }

    private JSONObject bookJson(Cursor c) throws Exception {
        String id = c.getString(0), cover = c.getString(4);
        String type = c.getString(2);
        File original = new File(new File(booksDir, id), "epub".equals(type) ? "original.epub" : "original.txt");
        return new JSONObject().put("id", id).put("title", c.getString(1)).put("type", c.getString(2))
                .put("author", c.getString(3)).put("coverUrl", cover.isEmpty() ? "" : "https://app.local/content/" + id + "/" + cover)
                .put("added", c.getLong(5)).put("lastOpened", c.getLong(6)).put("progress", c.getDouble(7))
                .put("currentChapter", c.getInt(8)).put("chapterCount", c.getInt(9)).put("originalName", c.getString(10)).put("fileSize", c.getLong(11))
                .put("category", c.getString(12)).put("tags", new JSONArray(c.getString(13))).put("description", c.getString(14))
                .put("available", original.isFile()).put("analyzed", c.getInt(15) != 0);
    }

    private static void upsertBook(SQLiteDatabase db, String id, String title, String type, String author, String coverPath, String originalName, long fileSize, int count) {
        long now = System.currentTimeMillis();
        boolean restoring = rowLong(db, "SELECT deleted FROM books WHERE id=?", id) == 1;
        String category="未分类", tags="[]", description="";
        try (Cursor c=db.rawQuery("SELECT category,tags,description,title,author FROM books WHERE id=?",new String[]{id})) { if(c.moveToFirst()){category=c.getString(0);tags=c.getString(1);description=c.getString(2);if(!c.getString(3).isEmpty())title=c.getString(3);if(!c.getString(4).isEmpty())author=c.getString(4);} }
        db.execSQL("INSERT OR REPLACE INTO books(id,title,type,author,cover_path,original_name,file_size,added,last_opened,progress,current_chapter,chapter_count,updated,deleted,category,tags,description) VALUES(?,?,?,?,?,?,?,?,0,0,0,?,?,0,?,?,?)", new Object[]{id, title, type, author, coverPath, originalName, fileSize, now, count, now, category, tags, description});
        try {
            JSONObject payload = new JSONObject().put("id", id).put("bookId", id).put("title", title).put("type", type).put("author", author)
                    .put("category",category).put("tags",new JSONArray(tags)).put("description",description).put("chapterCount", count).put("originalName", originalName).put("fileSize", fileSize).put("blobSha256", id).put("updatedAt", now);
            if (restoring) payload.put("restoreDeleted", true);
            recordChange(db, "book", id, "upsert", payload.toString(), now);
        } catch (Exception ignored) {}
    }

    private static void insertChapter(SQLiteDatabase db, String id, int index, String title, String path, int depth) {
        db.execSQL("INSERT INTO chapters(book_id,idx,title,path,depth) VALUES(?,?,?,?,?)", new Object[]{id, index, title, path, Math.max(0, Math.min(8, depth))});
    }

    private String queryName(Uri uri) {
        try (Cursor c = context.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int column = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) return c.getString(column);
            }
        }
        String segment = uri.getLastPathSegment();
        return segment == null ? "未命名书籍" : segment;
    }

    private static List<String> splitTxt(String text) {
        Pattern heading = Pattern.compile("(?m)^(?:第[零一二三四五六七八九十百千万0-9]+[章节卷回部篇]|Chapter\\s+\\d+).*$", Pattern.CASE_INSENSITIVE);
        Matcher matcher = heading.matcher(text);
        List<Integer> starts = new ArrayList<>();
        while (matcher.find()) starts.add(matcher.start());
        List<String> result = new ArrayList<>();
        if (starts.size() >= 2) {
            if (starts.get(0) > 0) result.add(text.substring(0, starts.get(0)).trim());
            for (int i = 0; i < starts.size(); i++) result.add(text.substring(starts.get(i), i + 1 < starts.size() ? starts.get(i + 1) : text.length()).trim());
        } else {
            int chunk = 18000;
            for (int start = 0; start < text.length();) {
                int end = Math.min(text.length(), start + chunk);
                if (end < text.length()) {
                    int newline = text.lastIndexOf('\n', end);
                    if (newline > start + chunk / 2) end = newline;
                }
                result.add(text.substring(start, end).trim()); start = end;
            }
        }
        result.removeIf(String::isEmpty);
        return result;
    }

    private static String paragraphs(String text) {
        StringBuilder out = new StringBuilder();
        for (String p : text.split("\\n\\s*\\n|\\n")) if (!p.trim().isEmpty()) out.append("<p>").append(escape(p.trim())).append("</p>");
        return out.toString();
    }

    private static String sanitizeHtml(String html) {
        return html.replaceAll("(?is)<(script|iframe|object|embed|form)[^>]*>.*?</\\1\\s*>", "")
                .replaceAll("(?is)<(script|iframe|object|embed|form)[^>]*/?>", "")
                .replaceAll("(?i)\\s+on[a-z]+\\s*=\\s*(['\"]).*?\\1", "")
                .replaceAll("(?i)javascript:", "");
    }

    private static void unzipSecurely(File zip, File destination) throws Exception {
        byte[] buffer = new byte[65536];
        long total = 0; int entries = 0;
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                if (++entries > 20000) throw new IllegalArgumentException("EPUB 文件条目过多");
                File out = safeFile(destination, entry.getName());
                if (entry.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (FileOutputStream stream = new FileOutputStream(out)) {
                    int read; long entrySize = 0;
                    while ((read = in.read(buffer)) != -1) {
                        total += read; entrySize += read;
                        if (total > 80L * 1024 * 1024) throw new IllegalArgumentException("EPUB 解压内容超过 80MB");
                        if (entrySize > 8L * 1024 * 1024) throw new IllegalArgumentException("EPUB 内单个资源超过 8MB");
                        stream.write(buffer, 0, read);
                    }
                }
            }
        }
    }

    private static Document parseXml(File file) throws Exception {
        String xml = decodeText(readAll(new FileInputStream(file))).replaceFirst("(?i)encoding\\s*=\\s*(['\"])[^'\"]+\\1", "encoding='utf-8'");
        return SafeXml.parse(xml.getBytes(StandardCharsets.UTF_8));
    }

    private static String combineSpineFiles(File root, List<String> paths, int index) throws Exception {
        StringBuilder combined = new StringBuilder("<article class=\"yuejian-logical-chapter\">");
        for (String path : paths) {
            String html = sanitizeHtml(decodeText(readAll(new FileInputStream(safeFile(root, path)))));
            Matcher body = Pattern.compile("(?is)<body[^>]*>(.*?)</body>").matcher(html);
            String content = body.find() ? body.group(1) : html;
            String parent = parentPath(path);
            if (!parent.isEmpty()) content = rebaseResourceAttributes(content, parent);
            combined.append("<section class=\"epub-spine-part\" data-source=\"").append(escape(path)).append("\">").append(content).append("</section>");
        }
        combined.append("</article>");
        String output = String.format(Locale.ROOT, "yuejian_chapter_%04d.html", index);
        writeFile(new File(root, output), combined.toString().getBytes(StandardCharsets.UTF_8));
        return output;
    }

    private static void appendAnchoredSections(File root, String path, List<TocEntry> entries, List<String> outputPaths, List<String> outputTitles, List<Integer> outputDepths) throws Exception {
        String html = sanitizeHtml(decodeText(readAll(new FileInputStream(safeFile(root, path)))));
        Matcher body = Pattern.compile("(?is)<body[^>]*>(.*?)</body>").matcher(html);
        String content = body.find() ? body.group(1) : html;
        String parent = parentPath(path);
        if (!parent.isEmpty()) content = rebaseResourceAttributes(content, parent);

        List<Integer> starts = new ArrayList<>();
        List<String> titles = new ArrayList<>();
        List<Integer> depths = new ArrayList<>();
        for (TocEntry entry : entries) {
            int start = entry.fragment.isEmpty() ? 0 : anchorStart(content, entry.fragment);
            if (start < 0 || (!starts.isEmpty() && start <= starts.get(starts.size() - 1))) continue;
            starts.add(start);
            titles.add(entry.title);
            depths.add(entry.depth);
        }
        if (starts.isEmpty()) {
            starts.add(0);
            titles.add(entries.get(0).title);
            depths.add(entries.get(0).depth);
        }
        for (int i = 0; i < starts.size(); i++) {
            int end = i + 1 < starts.size() ? starts.get(i + 1) : content.length();
            String section = content.substring(starts.get(i), end).trim();
            if (section.isEmpty()) continue;
            String output = String.format(Locale.ROOT, "yuejian_chapter_%04d.html", outputPaths.size());
            String wrapped = "<article class=\"yuejian-logical-chapter\">" + section + "</article>";
            writeFile(new File(root, output), wrapped.getBytes(StandardCharsets.UTF_8));
            outputPaths.add(output);
            outputTitles.add(titles.get(i));
            outputDepths.add(depths.get(i));
        }
    }

    static int anchorStart(String html, String fragment) {
        if (fragment == null || fragment.isEmpty()) return 0;
        Pattern pattern = Pattern.compile("(?is)<[a-z][^>]*\\b(?:id|name)\\s*=\\s*(['\"])" + Pattern.quote(fragment) + "\\1[^>]*>");
        Matcher marker = pattern.matcher(html);
        return marker.find() ? marker.start() : -1;
    }

    private static String rebaseResourceAttributes(String html, String parent) {
        Matcher matcher = Pattern.compile("(?i)(src|href)\\s*=\\s*(['\"])(?![a-z]+:|/|#)([^'\"]+)\\2").matcher(html);
        StringBuffer out = new StringBuffer();
        while (matcher.find()) matcher.appendReplacement(out, matcher.group(1) + "=" + matcher.group(2) + Matcher.quoteReplacement(parent + matcher.group(3)) + matcher.group(2));
        matcher.appendTail(out); return out.toString();
    }

    private static String extractHtmlTitle(File file, String fallback) {
        try {
            String html = decodeText(readAll(new FileInputStream(file)));
            Matcher m = Pattern.compile("(?is)<(?:h1|h2|h3)[^>]*>(.*?)</(?:h1|h2|h3)>").matcher(html);
            if (m.find()) return m.group(1).replaceAll("<[^>]+>", "").replaceAll("\\s+", " ").trim();
            m = Pattern.compile("(?is)<title[^>]*>(.*?)</title>").matcher(html);
            if (m.find()) return m.group(1).replaceAll("<[^>]+>", "").replaceAll("\\s+", " ").trim();
        } catch (Exception ignored) {}
        return fallback;
    }

    private static String coverFromHtml(File root, String htmlPath) {
        try {
            String html = decodeText(readAll(new FileInputStream(safeFile(root, htmlPath))));
            Matcher image = Pattern.compile("(?is)<img[^>]+src\\s*=\\s*(['\"])(.*?)\\1").matcher(html);
            if (!image.find()) return "";
            String candidate = resolvePath(parentPath(htmlPath), image.group(2));
            return isUsableCover(root, candidate) ? candidate : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean isUsableCover(File root, String path) {
        try {
            File file = safeFile(root, path);
            if (!file.isFile() || file.length() <= 0 || file.length() > 8L * 1024 * 1024) return false;
            String extension = MimeTypeMap.getFileExtensionFromUrl(path).toLowerCase(Locale.ROOT);
            return extension.matches("jpe?g|png|webp|gif|avif");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void collectNavEntries(File root, String navPath, List<TocEntry> entries) {
        try {
            Document document = parseXml(safeFile(root, navPath)); NodeList links = document.getElementsByTagNameNS("*", "a");
            for (int i = 0; i < links.getLength(); i++) { Element link = (Element) links.item(i); String href = link.getAttribute("href"), text = link.getTextContent().replaceAll("\\s+", " ").trim(); int depth=0; org.w3c.dom.Node p=link.getParentNode(); while(p!=null){if(p instanceof Element && "li".equalsIgnoreCase(((Element)p).getLocalName()))depth++;p=p.getParentNode();} if (!href.isEmpty() && !text.isEmpty()) entries.add(tocEntry(parentPath(navPath), href, text, Math.max(0,depth-1))); }
        } catch (Exception ignored) {}
    }

    private static void collectNcxEntries(File root, String ncxPath, List<TocEntry> entries) {
        try {
            Document document = parseXml(safeFile(root, ncxPath)); NodeList points = document.getElementsByTagNameNS("*", "navPoint");
            for (int i = 0; i < points.getLength(); i++) { Element point = (Element) points.item(i); NodeList content = point.getElementsByTagNameNS("*", "content"), labels = point.getElementsByTagNameNS("*", "text"); int depth=0; org.w3c.dom.Node p=point.getParentNode(); while(p!=null){if(p instanceof Element && "navPoint".equalsIgnoreCase(((Element)p).getLocalName()))depth++;p=p.getParentNode();} if (content.getLength() > 0 && labels.getLength() > 0) { String src = ((Element) content.item(0)).getAttribute("src"), text = labels.item(0).getTextContent().replaceAll("\\s+", " ").trim(); if (!src.isEmpty() && !text.isEmpty()) entries.add(tocEntry(parentPath(ncxPath), src, text, depth)); } }
        } catch (Exception ignored) {}
    }

    private static TocEntry tocEntry(String base, String reference, String title, int depth) throws Exception {
        String[] parts = reference.split("#", 2);
        String path = resolvePath(base, parts[0]);
        String fragment = parts.length > 1 ? URLDecoder.decode(parts[1], "UTF-8") : "";
        return new TocEntry(path, fragment, title, depth);
    }

    private static String firstTagText(Document doc, String name, String fallback) {
        NodeList list = doc.getElementsByTagNameNS("*", name);
        return list.getLength() > 0 && !list.item(0).getTextContent().trim().isEmpty() ? list.item(0).getTextContent().trim() : fallback;
    }

    private static String firstMeaningfulLine(String value, String fallback) {
        for (String line : value.split("\\n")) if (!line.trim().isEmpty()) return line.trim().length() > 80 ? fallback : line.trim();
        return fallback;
    }

    private static String decodeText(byte[] bytes) {
        if (bytes.length >= 2 && bytes[0] == (byte)0xFF && bytes[1] == (byte)0xFE) return new String(bytes, Charset.forName("UTF-16LE")).replace("\uFEFF", "");
        if (bytes.length >= 2 && bytes[0] == (byte)0xFE && bytes[1] == (byte)0xFF) return new String(bytes, Charset.forName("UTF-16BE")).replace("\uFEFF", "");
        String utf8 = new String(bytes, StandardCharsets.UTF_8);
        long replacements = utf8.chars().filter(c -> c == 0xFFFD).count();
        if (replacements > Math.max(2, utf8.length() / 500)) return new String(bytes, Charset.forName("GB18030"));
        return utf8.replace("\uFEFF", "");
    }

    private static File safeFile(File root, String path) throws Exception {
        File file = new File(root, path.replace('\\', '/')).getCanonicalFile();
        String base = root.getCanonicalPath() + File.separator;
        if (!file.getPath().startsWith(base)) throw new SecurityException("非法文件路径");
        return file;
    }

    private static String resolvePath(String base, String relative) throws Exception {
        String cleaned = URLDecoder.decode(relative.split("#", 2)[0], "UTF-8").replace('\\', '/');
        java.net.URI uri = new java.net.URI(null, null, "/" + (base.isEmpty() ? "" : base + "/") + cleaned, null).normalize();
        return uri.getPath().replaceFirst("^/", "");
    }

    private static String parentPath(String path) { int i = path.lastIndexOf('/'); return i < 0 ? "" : path.substring(0, i + 1); }
    private static String stripExtension(String name) { int dot = name.lastIndexOf('.'); return dot > 0 ? name.substring(0, dot) : name; }
    private static void requireBookId(String id) { if (id == null || !id.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("书籍标识无效"); }
    private static String escape(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;"); }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) { copy(source, out); return out.toByteArray(); }
    }
    private static void copy(InputStream in, java.io.OutputStream out) throws Exception { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) >= 0) out.write(b, 0, n); }
    private static void writeFile(File file, byte[] data) throws Exception { file.getParentFile().mkdirs(); try (FileOutputStream out = new FileOutputStream(file)) { out.write(data); } }
    private static void deleteTree(File file) { if (!file.exists()) return; if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child); } file.delete(); }
    private static String sha256(File file) throws Exception { MessageDigest digest = MessageDigest.getInstance("SHA-256"); try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) >= 0) digest.update(b, 0, n); } StringBuilder out = new StringBuilder(); for (byte b : digest.digest()) out.append(String.format("%02x", b)); return out.toString(); }
}
