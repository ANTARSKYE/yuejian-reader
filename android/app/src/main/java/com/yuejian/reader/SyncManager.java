package com.yuejian.reader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

final class SyncManager {
    interface Progress { void update(JSONObject value); }
    private final BookRepository repository;
    private final AccountStore account;

    SyncManager(BookRepository repository, AccountStore account) { this.repository = repository; this.account = account; }

    synchronized JSONObject status() throws Exception { return account.status(repository.pendingSyncCount() + repository.pendingBlobCount()); }

    synchronized JSONObject login(String serverUrl, String username, String password, boolean register, String deviceName) throws Exception {
        return login(serverUrl, username, password, register, deviceName, null);
    }

    synchronized JSONObject login(String serverUrl, String username, String password, boolean register, String deviceName, Progress progress) throws Exception {
        emit(progress, "discovering", 0, 1, 0, 0, 0, 0);
        if (password == null || password.length() < 8 || password.length() > 200) throw new IllegalArgumentException("密码长度需为 8–200 位");
        String cleanUrl = serverUrl == null || serverUrl.trim().isEmpty() || "auto".equalsIgnoreCase(serverUrl.trim())
                ? HttpSyncTransport.discoverServer() : HttpSyncTransport.validateServerUrl(serverUrl);
        String cleanUser = username == null ? "" : username.trim().toLowerCase();
        String cleanDevice = deviceName == null || deviceName.trim().isEmpty() ? "Android device" : deviceName.trim().substring(0, Math.min(80, deviceName.trim().length()));
        JSONObject request = new JSONObject().put("username", cleanUser).put("password", password)
                .put("deviceId", account.deviceId()).put("deviceName", cleanDevice);
        JSONObject result = HttpSyncTransport.account(cleanUrl, register ? "/api/v1/account/register" : "/api/v1/account/login", request);
        if (!"yuejian-sync-v1".equals(result.optString("protocol")) || result.optString("accessToken").isEmpty()) throw new IllegalStateException("同步服务器协议不兼容");
        account.saveLogin(cleanUrl, cleanUser, cleanDevice, result.getString("accessToken"));
        JSONObject initial = repository.queueFullSyncSnapshot();
        account.snapshotComplete();
        emit(progress, "preparing", 1, 1, 0, 0, 0, 0);
        JSONObject synced = syncNow(progress);
        return status().put("initialSnapshot", initial).put("sync", synced);
    }

    synchronized JSONObject logout() throws Exception {
        if (account.accountMode()) try { new HttpSyncTransport(account.serverUrl(), account.token()).logout(); } catch (Exception ignored) {}
        account.logout();
        return status();
    }

    synchronized JSONObject syncNow() throws Exception {
        return syncNow(null);
    }

    synchronized JSONObject syncNow(Progress progress) throws Exception {
        return syncNow(progress, true);
    }

    private JSONObject syncNow(Progress progress, boolean allowRediscovery) throws Exception {
        if (!account.accountMode()) return new JSONObject().put("mode", "local").put("skipped", true).put("pendingChanges", repository.pendingSyncCount());
        try {
            if (account.snapshotVersion() < 2) { repository.queueFullSyncSnapshot(); account.snapshotComplete(); }
            if (!account.lastError().isEmpty()) {
                try { account.serverUrl(HttpSyncTransport.discoverServer()); }
                catch (Exception ignored) {}
            }
            HttpSyncTransport transport = new HttpSyncTransport(account.serverUrl(), account.token());
            long remoteCursor = account.cursor(); int uploaded = 0, downloaded = 0, conflicts = 0, uploadedBlobs = 0, downloadedBlobs = 0;
            emit(progress, "exchanging", 0, Math.max(1, repository.pendingSyncCount()), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            for (int round = 0; round < 10; round++) {
                JSONObject local = repository.syncChanges(0, 200);
                JSONArray outgoing = local.getJSONArray("changes");
                JSONObject request = new JSONObject().put("protocol", "yuejian-sync-v1").put("protocolVersion", 1)
                        .put("deviceId", account.deviceId()).put("cursor", remoteCursor).put("changes", outgoing).put("limit", 200);
                JSONObject response = transport.exchange(request);
                if (!"yuejian-sync-v1".equals(response.optString("protocol"))) throw new IllegalStateException("同步服务器协议不兼容");
                JSONArray remote = response.optJSONArray("changes"); if (remote == null) remote = new JSONArray();
                for (int index = 0; index < remote.length(); index++) repository.applyRemoteChange(remote.getJSONObject(index));
                long next = response.optLong("nextCursor", remoteCursor);
                if (next < remoteCursor) throw new IllegalStateException("同步游标无效");
                remoteCursor = next; account.cursor(remoteCursor);
                JSONArray accepted = response.optJSONArray("accepted"); if (accepted == null) accepted = new JSONArray();
                long ackCursor = acknowledgedPrefix(outgoing, accepted);
                if (ackCursor > 0) repository.acknowledgeSync(ackCursor);
                uploaded += accepted.length(); downloaded += remote.length();
                emit(progress, "exchanging", uploaded + downloaded, Math.max(1, uploaded + downloaded + repository.pendingSyncCount()), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
                JSONArray conflictItems = response.optJSONArray("conflicts"); conflicts += conflictItems == null ? 0 : conflictItems.length();
                if (!response.optBoolean("hasMore") && repository.pendingSyncCount() == 0) break;
            }
            JSONArray localBooks = repository.syncableBookBlobs();
            emit(progress, "uploadingBooks", 0, localBooks.length(), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            for (int index = 0; index < localBooks.length(); index++) {
                JSONObject book = localBooks.getJSONObject(index); String id = book.getString("id");
                if (!transport.hasBlob(id)) {
                    transport.putBlob(id, new File(book.getString("path")), "epub".equals(book.optString("type")) ? "application/epub+zip" : "text/plain");
                    uploadedBlobs++;
                }
                emit(progress, "uploadingBooks", index + 1, localBooks.length(), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            }
            JSONArray missing = repository.missingBookBlobs();
            emit(progress, "downloadingBooks", 0, missing.length(), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            for (int index = 0; index < missing.length(); index++) {
                JSONObject book = missing.getJSONObject(index); File temporary = repository.createSyncTemporary();
                try {
                    transport.getBlob(book.getString("id"), temporary);
                    repository.importSyncedBlob(temporary, book); downloadedBlobs++;
                } catch (IllegalStateException unavailable) {
                    if (!unavailable.getMessage().contains("暂未上传") && !unavailable.getMessage().contains("404")) throw unavailable;
                } finally { temporary.delete(); }
                emit(progress, "downloadingBooks", index + 1, missing.length(), uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            }
            JSONObject completed = new JSONObject().put("mode", "account").put("ok", true).put("uploaded", uploaded)
                    .put("downloaded", downloaded).put("conflicts", conflicts).put("uploadedBlobs", uploadedBlobs)
                    .put("downloadedBlobs", downloadedBlobs).put("pendingChanges", repository.pendingSyncCount());
            account.synced(System.currentTimeMillis(), completed);
            emit(progress, "complete", 1, 1, uploaded, downloaded, uploadedBlobs, downloadedBlobs);
            return completed;
        } catch (Exception error) {
            if (allowRediscovery && connectionFailure(error)) {
                try {
                    String discovered = HttpSyncTransport.discoverServer();
                    account.serverUrl(discovered);
                    emit(progress, "reconnecting", 0, 1, 0, 0, 0, 0);
                    return syncNow(progress, false);
                } catch (Exception ignored) {}
            }
            String friendly = message(error);
            account.failed(friendly);
            return new JSONObject().put("mode", "account").put("ok", false).put("offline", true)
                    .put("error", friendly).put("pendingChanges", repository.pendingSyncCount());
        }
    }

    private static void emit(Progress progress, String phase, int done, int total, int uploaded, int downloaded, int uploadedBooks, int downloadedBooks) {
        if (progress == null) return;
        try { progress.update(new JSONObject().put("phase", phase).put("done", done).put("total", total)
                .put("uploadedItems", uploaded).put("downloadedItems", downloaded).put("uploadedBooks", uploadedBooks).put("downloadedBooks", downloadedBooks)); }
        catch (Exception ignored) {}
    }

    private static long acknowledgedPrefix(JSONArray outgoing, JSONArray accepted) throws Exception {
        java.util.HashSet<String> ids = new java.util.HashSet<>();
        for (int index = 0; index < accepted.length(); index++) ids.add(accepted.getString(index));
        long cursor = 0;
        for (int index = 0; index < outgoing.length(); index++) {
            JSONObject item = outgoing.getJSONObject(index);
            if (!ids.contains(item.getString("changeId"))) break;
            cursor = item.optLong("cursor", cursor);
        }
        return cursor;
    }

    private static String message(Exception error) {
        String value = error.getMessage();
        if (value == null || value.trim().isEmpty()) return "同步服务器未开启或当前网络不可达";
        String lowered = value.toLowerCase();
        if (lowered.contains("failed to connect") || lowered.contains("connection refused") || lowered.contains("connect timed out") || lowered.contains("timeout"))
            return "无法连接电脑同步服务器。请确认服务器窗口保持打开，手机和电脑连接同一普通 Wi-Fi，并关闭手机 VPN、网络加速、移动数据切换及访客网络。";
        if (lowered.contains("network is unreachable") || lowered.contains("no route to host"))
            return "手机与电脑当前不在可互通的局域网，请关闭 VPN/访客 Wi-Fi/设备隔离后重试。";
        return value;
    }

    private static boolean connectionFailure(Exception error) {
        String value = error.getMessage(); if (value == null) return error instanceof java.io.IOException;
        String lowered = value.toLowerCase();
        return error instanceof java.io.IOException || lowered.contains("failed to connect") || lowered.contains("connection") || lowered.contains("timeout") || lowered.contains("unreachable");
    }
}
