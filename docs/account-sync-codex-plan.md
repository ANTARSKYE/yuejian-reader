# Codex 实施指引：账户模式与多端阅读数据同步

本文档面向下一步本地编码代理。目标是在保留当前“本地优先”体验的基础上，为阅见新增可选账户模式：用户不登录时完全走本地模式；用户选择登录后才尝试联网，与运行在这台电脑上的同步服务器交换私人阅读数据，从而实现 Windows / Android 多端互通。

## 0. 当前项目审查结论

项目现状：

- Windows 桌面端是 `server.py` + `index.html` + `assets/app.js` 的本地 Web 阅读器。
- 当前 Windows 服务启动后只绑定 `127.0.0.1`，随机/指定端口，使用一次性本地访问令牌、Host / Origin 校验和 HttpOnly Cookie。这个安全边界不要直接拆掉。
- Windows 本地数据目录是 `%LOCALAPPDATA%\Yuejian\`，主要包括：
  - `library/`：书籍原文件与封面。
  - `library.json`：书架索引。
  - `ui-state.json`：前端 `localStorage` 中 `yuejian-*` 状态的持久化结果。
  - `analysis-cache.json`、`analysis-chunks.json`、`analysis-timings.json`：AI 分析相关缓存。
  - `ai-config.secure.json`：AI 密钥，已用 Windows DPAPI 保护，绝对不要同步。
- `storage.py` 已经提供跨线程/进程锁与原子 JSON 写入，继续复用。
- `assets/ui-storage.js` 会拦截 `localStorage.setItem/removeItem/clear`，把所有 `yuejian-*` 键增量保存到 `/api/ui-state`。
- `assets/app.js` 里的主要私人阅读数据目前集中在这些 `localStorage` 键：
  - `yuejian-reading-stats`：阅读时长、已读章节、每日统计。
  - `yuejian-annotations`：段落批注、标红。
  - `yuejian-reader-marks`：精确选段标记、笔记。
  - `yuejian-reading-meta`：书籍阅读元信息。
  - `yuejian-reader-font`、`yuejian-reader-font-size`、`yuejian-theme`、`yuejian-custom-bg` 等 UI 偏好。
  - `yuejian-profile-name`、`yuejian-profile-avatar` 等个人资料。
- Android 端已经预留了同步方向：
  - `android/app/src/main/java/com/yuejian/reader/SyncContract.java` 声明 `yuejian-sync-v1`、`/api/v1/sync/exchange`、blob 接口和 neverSync 字段。
  - `android/app/src/main/java/com/yuejian/reader/BookRepository.java` 已有 `sync_outbox` 表、`syncChanges(after, limit)`、`acknowledgeSync(cursor)`、`recordChange(...)`。
  - `android/README.md` 明确写了 `yuejian-sync-v1 Outbox 与账户服务器接口契约（当前默认本地模式）`。

结论：不要推倒重写。下一步应围绕既有 `yuejian-sync-v1` 做“账户服务器 + Windows 同步 outbox + Android 真正联网 exchange”的最小闭环。

## 1. 产品目标

必须实现两个模式：

### 本地模式（默认）

- 用户不登录时，软件行为必须与现在一致。
- 不主动访问同步服务器，不弹登录，不要求网络。
- AI 在线接口、在线书库等已有联网能力不属于账户同步，不要混为一谈。
- 本地数据继续保存在原来的本机目录或 Android 应用私有目录。

### 账户模式（用户主动登录后）

- 用户在设置页选择“登录/连接同步服务器”。
- 登录成功后保存：`serverUrl`、`username`、`deviceId`、`accessToken`、`syncMode=account`。
- 启动、打开书架、阅读进度变化、批注/标记变化、手动点击“立即同步”时，尝试与服务器交换数据。
- 服务器未开启、网络不可达、访问令牌过期时，不影响本地阅读；只显示“离线/待同步”，保留本地 outbox，下次再同步。
- 同步服务器就运行在这台电脑上，可先支持局域网，例如 `http://电脑局域网IP:8787`。公网穿透不是 MVP 必需项。

## 2. 推荐架构

不要让现有桌面阅读服务直接暴露给局域网。

推荐拆成两个角色：

1. **本地阅读后端**：现有 `server.py`，继续默认只绑定 `127.0.0.1`，负责桌面 UI、书籍解析、AI、备份恢复、本地文件访问。
2. **账户同步服务器**：新增 `sync_server.py` 或在 `server.py` 增加独立启动模式，例如 `python sync_server.py --host 0.0.0.0 --port 8787`。它只提供账户登录、同步 exchange、blob 上传下载，不提供桌面阅读 UI，不复用桌面临时访问令牌。

好处：

- 不破坏当前本地安全模型。
- 手机访问的是同步 API，而不是完整桌面阅读服务。
- Windows 桌面端仍然只让前端请求本地 `/api/account/*`，由本地 Python 去访问同步服务器，避免 CSP / CORS 麻烦。
- Android 端可在 Java 层实现 `HttpSyncTransport`，WebView JS 仍调用 `Yuejian.*` 原生桥。

## 3. 数据同步范围

MVP 优先同步“私人阅读信息”，不要一开始就追求全量云盘。

### 第一阶段必须同步

- 账户资料：昵称、头像等非敏感偏好。
- 书架元数据：书籍 hash、标题、原始文件名、文件大小、加入时间、最后打开时间。
- 阅读进度：当前章节、章节内位置、更新时间。
- 阅读统计：每日时长、字数、已读章节。
- 批注 / 标红 / 精确选段笔记。
- 书签。
- 主题、字体、常用 UI 偏好。

### 第一阶段可选同步

- AI 分析结果：可以同步，但注意体积；建议先允许用户配置“同步 AI 分析缓存”。默认可不同步，或者只同步最终报告，不同步分块过程缓存。
- 名言库、自定义书源：可以同步，冲突风险较低。

### 第一阶段不要同步

- AI API 密钥。
- 登录令牌明文。
- 本地绝对路径。
- WebView Cookie、日志、临时文件。
- 任何无法确认属于当前账户的文件。

### 书籍原文件策略

多端互通通常需要同步书籍原文件，否则另一端只有阅读进度但打不开书。

建议分两层：

1. **元数据同步必做**：所有设备都知道这本书存在。
2. **blob 同步可选但建议做 MVP**：以 SHA-256 为 key，同步 `.epub/.txt` 和封面。服务端提供：
   - `HEAD /api/v1/blobs/{sha256}`：判断服务器是否已有。
   - `PUT /api/v1/blobs/{sha256}`：上传书籍或封面。
   - `GET /api/v1/blobs/{sha256}`：下载。

注意：书籍 blob 必须限制大小，沿用当前 30MB 上传限制。不要同步用户没有权利传播的内容到第三方服务器；本方案默认服务器在用户自己的电脑上。

## 4. 协议设计：沿用 `yuejian-sync-v1`

### 登录接口

新增账户服务器接口：

```text
POST /api/v1/account/register
POST /api/v1/account/login
POST /api/v1/account/logout
GET  /api/v1/account/me
GET  /api/v1/health
```

注册 / 登录请求示例：

```json
{
  "username": "chen",
  "password": "[REDACTED_SECRET]",
  "deviceId": "uuid-v4",
  "deviceName": "Windows 电脑 / Android 手机"
}
```

登录响应示例：

```json
{
  "ok": true,
  "protocol": "yuejian-sync-v1",
  "accountId": "acc_xxx",
  "deviceId": "uuid-v4",
  "accessToken": "[REDACTED_SECRET]",
  "serverTime": 1780000000000
}
```

安全要求：

- 密码不能明文保存。
- 不新增重量依赖时，Python 端可用标准库 `hashlib.pbkdf2_hmac` + 每用户随机 salt + 足够迭代次数。
- 访问令牌用 `secrets.token_urlsafe(32)` 以上随机值。
- 服务端数据库里保存访问令牌的 hash，不保存明文。
- 所有 `/api/v1/sync/*` 和 blob 写入接口都必须校验 `Authorization: Bearer [REDACTED_SECRET]` 格式。

### 同步 exchange 接口

使用 Android 已声明的端点：

```text
POST /api/v1/sync/exchange
```

请求示例：

```json
{
  "protocol": "yuejian-sync-v1",
  "protocolVersion": 1,
  "deviceId": "uuid-v4",
  "cursor": 123,
  "changes": [
    {
      "changeId": "uuid-v4",
      "entityType": "progress",
      "entityId": "bookSha256",
      "operation": "upsert",
      "payload": {
        "bookId": "bookSha256",
        "chapter": 5,
        "progress": 0.42,
        "updatedAt": 1780000000000
      },
      "createdAt": 1780000000000
    }
  ],
  "limit": 200
}
```

响应示例：

```json
{
  "protocol": "yuejian-sync-v1",
  "protocolVersion": 1,
  "accepted": ["changeId-1", "changeId-2"],
  "conflicts": [],
  "changes": [
    {
      "serverSeq": 124,
      "changeId": "remote-change-id",
      "entityType": "annotation",
      "entityId": "annotation-id",
      "operation": "upsert",
      "payload": {},
      "createdAt": 1780000001000
    }
  ],
  "nextCursor": 124,
  "hasMore": false
}
```

规则：

- `changeId` 是幂等键，服务端重复收到必须返回 accepted，不重复应用。
- `cursor` 表示客户端已经拉取到的服务端全局序号。
- 服务端响应中不要把本设备刚刚提交的变化再回传给同一设备，或者客户端收到后必须按 `changeId` 去重。
- `operation` 支持 `upsert` 和 `delete`。
- 删除使用 tombstone，不能简单物理删除后让别的设备复活旧数据。

## 5. 服务端存储建议

账户同步服务器使用 SQLite，放在：

```text
%LOCALAPPDATA%\Yuejian\sync-server\sync.db
%LOCALAPPDATA%\Yuejian\sync-server\blobs\
```

建议表：

```sql
CREATE TABLE users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE changes(
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  change_id TEXT UNIQUE NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE entities(
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, entity_type, entity_id)
);

CREATE TABLE blobs(
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

服务端合并策略 MVP：

- 对 `progress`：按 `updatedAt` 后者覆盖前者；同书只保留最新章节/位置。
- 对 `reading_daily`：同一天同书的 `seconds/chars` 使用增量或取最大值，避免重复累计。建议 payload 携带 `day` 和当前设备累计值，服务端实体取每设备明细后再汇总；MVP 可先取最大值，避免越同步越膨胀。
- 对 `annotation`、`bookmark`、`reader_mark`：每条有独立 `id`，按 `updatedAt` 后者覆盖；删除以 tombstone 覆盖旧值。
- 对 `app_state`：按 key 拆成独立实体，后写覆盖。
- 对 `book`：同一 `bookId=sha256` 合并元数据，保留最早 `addedAt`、最新 `lastOpened`。
- 对 `analysis`：按 `updatedAt` 后者覆盖；可限制 payload 大小。

## 6. Windows 端改造步骤

### 6.1 新增同步配置文件

新增类似：

```text
%LOCALAPPDATA%\Yuejian\account.json
%LOCALAPPDATA%\Yuejian\sync-outbox.json
%LOCALAPPDATA%\Yuejian\sync-cursor.json
```

或者直接使用 SQLite。若继续使用 JSON，必须复用 `storage.py` 的原子读写。

`account.json` 存：

```json
{
  "mode": "local | account",
  "serverUrl": "http://192.168.1.10:8787",
  "username": "chen",
  "deviceId": "uuid-v4",
  "deviceName": "Windows Desktop",
  "tokenProtected": "[REDACTED_SECRET]",
  "lastSyncAt": "2026-07-15T...Z"
}
```

注意：Windows 上访问令牌用现有 DPAPI 思路保护；不要明文落盘。

### 6.2 新增本地账户 API

在 `server.py` 的本地 API 中增加：

```text
GET  /api/account/status
POST /api/account/login
POST /api/account/logout
POST /api/sync/now
GET  /api/sync/status
```

这些接口是桌面前端调用本地后端，不直接跨域访问账户服务器。

行为：

- `/api/account/status` 返回当前模式、用户名、serverUrl、lastSyncAt、pendingChanges、lastError。
- `/api/account/login` 接收 serverUrl/username/password，调用远端 `/api/v1/account/login`，成功后保存 account 配置并立即触发一次 sync。
- `/api/account/logout` 只退出本设备账户模式，不删除本地阅读数据；可选择清空访问令牌和 serverUrl。
- `/api/sync/now` 只在 account 模式下工作；本地模式返回 `{mode:"local", skipped:true}`。
- `/api/sync/status` 返回待同步数量、最近错误。

### 6.3 Windows 端记录 outbox

目前 Windows 端所有 `yuejian-*` 数据都被整体/增量写入 `ui-state.json`，但没有 outbox。下一步要在 `patch_ui_state(...)` 或更上层把变化转成 sync change。

建议先做一个转换层：

- `sync_local.py`：
  - `record_change(entity_type, entity_id, operation, payload)`
  - `pending_changes(after=0, limit=200)`
  - `acknowledge_changes(change_ids)`
  - `apply_remote_change(change)`
  - `run_sync_once()`
- 当 `patch_ui_state` 更新这些 key 时，解析对应 JSON 并拆成实体：
  - `yuejian-reading-stats` -> `reading_daily` / `progress`。
  - `yuejian-annotations` -> `annotation`。
  - `yuejian-reader-marks` -> `reader_mark`。
  - `yuejian-reading-meta` -> `book_meta`。
  - 主题、字体、个人资料 -> `app_state`。

MVP 可以先采用“整键同步”，即把每个 `yuejian-*` key 当作 `app_state` 实体同步：

```json
{
  "entityType": "app_state",
  "entityId": "yuejian-reading-stats",
  "operation": "upsert",
  "payload": {
    "key": "yuejian-reading-stats",
    "value": "原始 JSON 字符串",
    "updatedAt": 1780000000000
  }
}
```

但这只是最快闭环，长期更推荐拆细，因为整键同步容易产生冲突覆盖，例如两台设备同时改不同批注。

### 6.4 Windows 端应用远程变化

远程变化应用到本地时必须避免再次产生 outbox 循环。

实现方式：

- `apply_remote_change(...)` 内部设置一个 `suppress_outbox=True` 上下文标记。
- 应用 `app_state` 时更新 `ui-state.json`。
- 如果当前浏览器页面已打开，前端不会自动知道 `ui-state.json` 被远程更新。MVP 可在同步成功后提示“同步完成，重新打开书籍后生效”；更好做法是新增 `/api/ui-state` 拉取并让前端合并刷新。

## 7. Android 端改造步骤

Android 已有 outbox 基础，下一步不要重复造模型。

### 7.1 实现 `HttpSyncTransport`

在 `android/app/src/main/java/com/yuejian/reader/` 下新增：

```text
HttpSyncTransport.java
AccountStore.java
SyncManager.java
```

职责：

- `AccountStore`：保存 `serverUrl`、`username`、`deviceId`、`accessToken`、`syncMode`。访问令牌用 Android Keystore 或至少放入应用私有 SharedPreferences；不要写入普通日志。
- `HttpSyncTransport`：用 `HttpURLConnection` 调用 `/api/v1/account/login` 和 `/api/v1/sync/exchange`。
- `SyncManager`：读取 `repository.syncChanges(cursor, limit)`，发送 exchange，调用 `repository.acknowledgeSync(cursor)`，再应用服务端返回 changes。

### 7.2 给 `BookRepository` 增加应用远程变化的方法

新增类似：

```java
synchronized void applyRemoteChange(JSONObject change)
```

根据 `entityType` 分发更新本地 SQLite：

- `progress` -> 更新 `books.current_chapter/progress/last_opened/updated`。
- `annotation` -> upsert/delete `annotations`。
- `bookmark` -> upsert/delete `bookmarks`。
- `analysis` -> upsert `analysis_cache`。
- `app_state` -> upsert `app_state`。
- `book` -> upsert `books` 元数据，缺 blob 时标记“未下载原文”。

应用远程变化时不要调用 `recordChange(...)`，否则会形成同步回声。

### 7.3 UI 增加账号入口

Android 的 `features.js` 里“我的阅见”页面已有“本地模式 · 已预留账户同步接口”文案。把它改成可用入口：

- 显示当前模式：本地模式 / 账户模式 / 离线待同步。
- 输入服务器地址、用户名、密码。
- 按钮：登录、退出登录、立即同步。
- 展示 pendingChanges、lastSyncAt、lastError。

## 8. 前端 UI 设计要求

Windows 和 Android 统一概念：

- 设置页增加“账户与同步”。
- 默认显示：`本地模式：数据只保存在本机，不会联网同步。`
- 登录区字段：
  - 服务器地址，例如 `http://192.168.1.10:8787`。
  - 用户名。
  - 密码。
- 登录成功后显示：
  - 用户名。
  - 服务器地址。
  - 最近同步时间。
  - 待同步条数。
  - 状态：已同步 / 离线 / 令牌失效 / 同步失败。
- 操作按钮：
  - 立即同步。
  - 退出登录。
  - 保持本地模式。

文案要明确：

- “不登录也可以完整使用阅见。”
- “服务器关闭时不会丢失数据，下次打开服务器后会继续同步。”
- “AI 密钥不会同步。”

## 9. 同步触发时机

MVP 触发点：

- 登录成功后立即同步一次。
- 应用启动并检测到账户模式时同步一次。
- 打开书架/进入个人页时同步一次。
- 批注、标红、书签、进度保存后，延迟 3–10 秒合并同步一次。
- 提供“立即同步”按钮。

不要每 5 秒阅读计时都发网络请求。阅读计时可本地累计，每隔一段时间或页面隐藏时入 outbox，同步请求需要 debounce。

## 10. 冲突与数据安全底线

必须保证：

- 服务器不可达时不影响阅读。
- 同步失败时不能清空本地 outbox。
- 同步成功并收到 accepted 后，才删除本地 outbox 中对应 change。
- 远程数据应用失败时不能推进 cursor。
- 删除必须使用 tombstone。
- 任何账户接口都不能同步 AI key、登录令牌、本地绝对路径、日志。
- 服务端需要限制 body 大小，避免手机误传超大数据拖垮电脑。
- blob 上传必须校验 SHA-256 与 URL 中 hash 一致。
- 账户服务器默认只建议在可信局域网使用；若暴露到公网，必须加 HTTPS 或通过可信隧道，不要把明文 HTTP 暴露到公网。

## 11. 推荐实施顺序

### Milestone 1：服务端最小可用

1. 新增 `sync_server.py`。
2. 用 SQLite 实现用户注册/登录、令牌校验。
3. 实现 `/api/v1/health`。
4. 实现 `/api/v1/sync/exchange`，先支持 `app_state`、`progress`、`annotation`、`bookmark`。
5. 增加 `tests/test_sync_server.py`：
   - 注册/登录成功。
   - 密码错误失败。
   - 无令牌访问 exchange 被拒绝。
   - 同一个 `changeId` 重复提交不会重复写入。
   - 一个设备提交后，另一个设备按 cursor 拉到变化。

### Milestone 2：Windows 账户模式闭环

1. 新增 `sync_local.py` 或等价模块。
2. 新增 `account.json`、`sync-outbox.json`、`sync-cursor.json` 的读写封装。
3. `server.py` 增加 `/api/account/status`、`/api/account/login`、`/api/account/logout`、`/api/sync/now`。
4. `patch_ui_state` 写入后记录 outbox。
5. `run_sync_once()` 成功后应用远程 `app_state` 变化。
6. Windows UI 增加账户与同步区域。
7. 测试本地模式仍然完全可用。

### Milestone 3：Android 真同步

1. 实现 `AccountStore`、`HttpSyncTransport`、`SyncManager`。
2. 用已有 `syncChanges` 和 `acknowledgeSync` 完成上传。
3. 增加 `applyRemoteChange` 完成下载应用。
4. Android “我的阅见”页面接入登录/同步状态。
5. 真机测试：Android 批注 -> Windows 同步显示；Windows 主题/批注 -> Android 同步显示。

### Milestone 4：blob 书籍文件同步

1. 服务端实现 blob 三个接口。
2. Windows 上传本地 `library/{sha256}.epub|txt`。
3. Android 缺书籍文件时显示“点击下载原文”。
4. 下载后校验 SHA-256，成功才写入本地书库。

## 12. 测试清单

运行现有测试：

```powershell
.\.venv\Scripts\python.exe -m pytest
node --check assets\app.js
```

新增测试建议：

- `tests/test_sync_server.py`
- `tests/test_sync_local.py`

必须覆盖：

- 本地模式不访问同步服务器。
- 登录成功后保存账户状态。
- 服务器关闭时 `/api/sync/now` 返回离线错误但不丢 outbox。
- 重复 `changeId` 幂等。
- cursor 不推进导致可重试。
- tombstone 删除不会被旧 upsert 复活。
- AI key 不出现在 backup、sync payload、日志中。
- blob 上传 hash 不匹配时拒绝。

Android 构建：

```powershell
cd android
.\build-android.ps1
```

## 13. 不要做的事

- 不要把现有桌面 `server.py` 默认改成 `0.0.0.0` 暴露整个阅读服务。
- 不要要求用户必须登录才能使用软件。
- 不要同步 AI API key。
- 不要在日志里打印密码、访问令牌、Authorization header。
- 不要每次阅读计时都即时联网。
- 不要引入大型 Web 框架，除非确实必要；当前项目依赖很轻，优先用标准库 `http.server`、`sqlite3`、`hashlib`、`secrets`。
- 不要只做 UI 按钮但没有 outbox/重试机制。多端同步的关键是离线可写、稍后交换。

## 14. 推荐给用户的启动方式

后续实现完成后，使用方式应类似：

电脑上启动同步服务器：

```powershell
.\.venv\Scripts\python.exe sync_server.py --host 0.0.0.0 --port 8787
```

Windows 阅见仍按原方式启动。

手机和另一台电脑在“账户与同步”中填写：

```text
http://电脑局域网IP:8787
```

服务器开着时同步；服务器关着时本地继续读，下次打开服务器再同步。
