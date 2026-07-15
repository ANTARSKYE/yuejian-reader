package com.yuejian.reader;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AccountStore {
    private static final String PREFS = "account_sync_v1";
    private static final String ALIAS = "yuejian-account-token-v1";
    private final SharedPreferences preferences;

    AccountStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.contains("device_id")) preferences.edit().putString("device_id", UUID.randomUUID().toString()).apply();
    }

    boolean accountMode() { return "account".equals(preferences.getString("mode", "local")); }
    String serverUrl() { return preferences.getString("server_url", ""); }
    void serverUrl(String value) { preferences.edit().putString("server_url", value == null ? "" : value).apply(); }
    String lastError() { return preferences.getString("last_error", ""); }
    String username() { return preferences.getString("username", ""); }
    String deviceId() { return preferences.getString("device_id", ""); }
    String deviceName() { return preferences.getString("device_name", "Android device"); }
    long cursor() { return preferences.getLong("cursor", 0); }
    void cursor(long value) { preferences.edit().putLong("cursor", Math.max(0, value)).apply(); }
    int snapshotVersion() { return preferences.getInt("snapshot_version", 0); }
    void snapshotComplete() { preferences.edit().putInt("snapshot_version", 2).apply(); }

    String token() throws Exception {
        String packed = preferences.getString("token", "");
        if (packed.isEmpty()) return "";
        byte[] all = Base64.decode(packed, Base64.NO_WRAP);
        if (all.length < 13) throw new IllegalStateException("账户令牌存储已损坏");
        byte[] iv = new byte[12], encrypted = new byte[all.length - 12];
        System.arraycopy(all, 0, iv, 0, 12); System.arraycopy(all, 12, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    void saveLogin(String serverUrl, String username, String deviceName, String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[cipher.getIV().length + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length);
        System.arraycopy(encrypted, 0, packed, cipher.getIV().length, encrypted.length);
        preferences.edit().putString("mode", "account").putString("server_url", serverUrl)
                .putString("username", username).putString("device_name", deviceName)
                .putString("token", Base64.encodeToString(packed, Base64.NO_WRAP))
                .putString("last_error", "").apply();
    }

    void synced(long at) { preferences.edit().putLong("last_sync", at).putString("last_error", "").apply(); }
    void synced(long at, JSONObject summary) { preferences.edit().putLong("last_sync", at).putString("last_error", "").putString("last_summary", summary == null ? "{}" : summary.toString()).apply(); }
    void failed(String error) { preferences.edit().putString("last_error", error == null ? "同步失败" : error.substring(0, Math.min(300, error.length()))).apply(); }
    void logout() {
        String deviceId = deviceId(), deviceName = deviceName();
        preferences.edit().clear().putString("mode", "local").putString("device_id", deviceId).putString("device_name", deviceName).apply();
    }

    JSONObject status(int pending) throws Exception {
        boolean account = accountMode();
        String error = preferences.getString("last_error", "");
        JSONObject summary; try { summary = new JSONObject(preferences.getString("last_summary", "{}")); } catch (Exception ignored) { summary = new JSONObject(); }
        return new JSONObject().put("mode", account ? "account" : "local")
                .put("connected", account && error.isEmpty()).put("offline", account && !error.isEmpty())
                .put("serverUrl", account ? serverUrl() : "").put("username", account ? username() : "")
                .put("deviceId", deviceId()).put("deviceName", deviceName())
                .put("pendingChanges", pending).put("lastSyncAt", preferences.getLong("last_sync", 0))
                .put("lastError", error).put("lastSyncSummary", summary).put("serverOptional", true).put("secureStorage", true);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
    }
}
