package com.yuejian.reader;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

final class BackupManager {
    static void exportData(Context context, Uri destination) throws Exception {
        try (OutputStream raw = context.getContentResolver().openOutputStream(destination, "w"); ZipOutputStream zip = new ZipOutputStream(raw)) {
            JSONObject manifest = new JSONObject().put("format", "yuejian-android-backup").put("schemaVersion", 1).put("createdAt", System.currentTimeMillis()).put("includesSecrets", false);
            putBytes(zip, "manifest.json", manifest.toString(2).getBytes(StandardCharsets.UTF_8));
            File database = context.getDatabasePath("yuejian.db");
            if (database.isFile()) putFile(zip, database, "database/yuejian.db");
            File books = new File(context.getFilesDir(), "books");
            if (books.isDirectory()) putTree(zip, books, "books/");
        }
    }

    static void restoreData(Context context, Uri source) throws Exception {
        File stage = new File(context.getCacheDir(), "restore-" + System.nanoTime()); stage.mkdirs();
        long total = 0; int entries = 0;
        try (InputStream raw = context.getContentResolver().openInputStream(source); ZipInputStream zip = new ZipInputStream(raw)) {
            ZipEntry entry; byte[] buffer = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                if (++entries > 30000) throw new IllegalArgumentException("备份文件条目过多");
                File out = safeFile(stage, entry.getName());
                if (entry.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (FileOutputStream stream = new FileOutputStream(out)) {
                    int read; while ((read = zip.read(buffer)) >= 0) { total += read; if (total > 1024L * 1024 * 1024) throw new IllegalArgumentException("备份文件过大"); stream.write(buffer, 0, read); }
                }
            }
            File manifestFile = new File(stage, "manifest.json"), database = new File(stage, "database/yuejian.db");
            if (!manifestFile.isFile() || !database.isFile()) throw new IllegalArgumentException("不是有效的阅见 Android 备份");
            JSONObject manifest = new JSONObject(new String(readAll(new FileInputStream(manifestFile)), StandardCharsets.UTF_8));
            if (!"yuejian-android-backup".equals(manifest.optString("format"))) throw new IllegalArgumentException("备份格式不受支持");
            SQLiteDatabase check = SQLiteDatabase.openDatabase(database.getPath(), null, SQLiteDatabase.OPEN_READONLY);
            try (Cursor cursor = check.rawQuery("SELECT COUNT(*) FROM books", null)) { if (!cursor.moveToFirst()) throw new IllegalArgumentException("备份数据库无效"); }
            finally { check.close(); }

            File liveDb = context.getDatabasePath("yuejian.db"),
                    liveBooks = new File(context.getFilesDir(), "books"),
                    stagedBooks = new File(stage, "books"),
                    rollback = new File(context.getCacheDir(), "restore-rollback-" + System.nanoTime()),
                    rollbackDb = new File(rollback, "yuejian.db"),
                    rollbackBooks = new File(rollback, "books");
            rollback.mkdirs();
            boolean hadDatabase = liveDb.isFile(), hadBooks = liveBooks.isDirectory();
            try {
                if (hadDatabase) copyFile(liveDb, rollbackDb);
                if (hadBooks) { rollbackBooks.mkdirs(); copyTree(liveBooks, rollbackBooks); }

                deleteTree(liveBooks); liveBooks.mkdirs();
                if (stagedBooks.isDirectory()) copyTree(stagedBooks, liveBooks);
                liveDb.getParentFile().mkdirs();
                copyFile(database, liveDb);
                new File(liveDb.getPath() + "-journal").delete();
                new File(liveDb.getPath() + "-wal").delete();
                new File(liveDb.getPath() + "-shm").delete();
            } catch (Exception replacementError) {
                deleteTree(liveBooks);
                if (hadBooks) { liveBooks.mkdirs(); copyTree(rollbackBooks, liveBooks); }
                if (hadDatabase) copyFile(rollbackDb, liveDb); else liveDb.delete();
                throw new IllegalStateException("恢复未完成，原有数据已自动回滚", replacementError);
            } finally {
                deleteTree(rollback);
            }
        } finally { deleteTree(stage); }
    }

    private static void putTree(ZipOutputStream zip, File directory, String prefix) throws Exception { File[] files = directory.listFiles(); if (files == null) return; for (File file : files) { String name = prefix + file.getName(); if (file.isDirectory()) putTree(zip, file, name + "/"); else putFile(zip, file, name); } }
    private static void putFile(ZipOutputStream zip, File file, String name) throws Exception { zip.putNextEntry(new ZipEntry(name)); try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) >= 0) zip.write(b, 0, n); } zip.closeEntry(); }
    private static void putBytes(ZipOutputStream zip, String name, byte[] value) throws Exception { zip.putNextEntry(new ZipEntry(name)); zip.write(value); zip.closeEntry(); }
    private static File safeFile(File root, String path) throws Exception { File file = new File(root, path.replace('\\', '/')).getCanonicalFile(); if (!file.getPath().startsWith(root.getCanonicalPath() + File.separator)) throw new SecurityException("备份包含非法路径"); return file; }
    private static void copyTree(File source, File target) throws Exception { File[] files = source.listFiles(); if (files == null) return; for (File file : files) { File out = new File(target, file.getName()); if (file.isDirectory()) { out.mkdirs(); copyTree(file, out); } else copyFile(file, out); } }
    private static void copyFile(File source, File target) throws Exception { target.getParentFile().mkdirs(); try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(target)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) >= 0) out.write(b, 0, n); } }
    private static byte[] readAll(InputStream in) throws Exception { try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] b = new byte[16384]; int n; while ((n = source.read(b)) >= 0) out.write(b, 0, n); return out.toByteArray(); } }
    private static void deleteTree(File file) { if (!file.exists()) return; if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child); } file.delete(); }
}
