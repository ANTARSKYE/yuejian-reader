package com.yuejian.reader;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureConfig {
    private static final String ALIAS = "yuejian-ai-key-v1";
    private static final String PREFS = "secure_config";
    private final SharedPreferences preferences;

    SecureConfig(Context context) { preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    JSONObject status() throws Exception {
        return new JSONObject().put("configured", preferences.contains("api_key"))
                .put("provider", preferences.getString("provider", "deepseek"))
                .put("model", preferences.getString("model", "deepseek-v4-flash"))
                .put("secureStorage", true);
    }

    JSONObject load() throws Exception {
        JSONObject result = status();
        String packed = preferences.getString("api_key", "");
        if (packed.isEmpty()) return result.put("apiKey", "");
        byte[] all = Base64.decode(packed, Base64.NO_WRAP);
        if (all.length < 13) throw new IllegalStateException("AI 密钥存储已损坏");
        byte[] iv = new byte[12], encrypted = new byte[all.length - 12];
        System.arraycopy(all, 0, iv, 0, 12); System.arraycopy(all, 12, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return result.put("apiKey", new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
    }

    void save(String provider, String model, String apiKey) throws Exception {
        if (!("openai".equals(provider) || "deepseek".equals(provider))) throw new IllegalArgumentException("不支持的 AI 服务商");
        if (apiKey == null || apiKey.trim().isEmpty() || apiKey.length() > 500) throw new IllegalArgumentException("请输入有效的 API 密钥");
        if (model == null || model.trim().isEmpty() || model.length() > 100) throw new IllegalArgumentException("请输入模型名称");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(apiKey.trim().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[cipher.getIV().length + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length); System.arraycopy(encrypted, 0, packed, cipher.getIV().length, encrypted.length);
        preferences.edit().putString("provider", provider).putString("model", model.trim()).putString("api_key", Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
    }

    void clear() { preferences.edit().clear().apply(); }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
    }
}
