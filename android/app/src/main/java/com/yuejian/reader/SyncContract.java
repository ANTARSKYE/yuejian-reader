package com.yuejian.reader;

import org.json.JSONArray;
import org.json.JSONObject;

/** Stable boundary for the future occasionally-online account server. */
interface SyncTransport {
    JSONObject exchange(JSONObject request) throws Exception;
}

final class NoopSyncTransport implements SyncTransport {
    @Override public JSONObject exchange(JSONObject request) throws Exception {
        return new JSONObject().put("protocolVersion", 1).put("mode", "local").put("connected", false)
                .put("accepted", new JSONArray()).put("conflicts", new JSONArray()).put("changes", new JSONArray())
                .put("nextCursor", request.optLong("cursor", 0)).put("hasMore", false);
    }
}

final class SyncContract {
    static final int PROTOCOL_VERSION = 1;
    static JSONObject capabilities() throws Exception {
        return new JSONObject().put("protocol", "yuejian-sync-v1").put("protocolVersion", PROTOCOL_VERSION)
                .put("mode", "local").put("accountEnabled", true).put("serverOptional", true)
                .put("exchangeEndpoint", "/api/v1/sync/exchange")
                .put("supportsAcknowledgement", true).put("supportsTombstones", true).put("idempotencyKey", "changeId")
                .put("blobEndpoints", new JSONArray().put("HEAD /api/v1/blobs/{sha256}").put("GET /api/v1/blobs/{sha256}").put("PUT /api/v1/blobs/{sha256}"))
                .put("neverSync", new JSONArray().put("ai_api_key").put("login_token").put("local_file_path"));
    }
    private SyncContract() {}
}
