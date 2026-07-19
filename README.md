# 阅见 Reader 1.5.2

阅见是一款面向 Windows、Android 手机和平板的本地优先 AI 电子书阅读器，支持 EPUB/TXT 阅读、分章深度分析、精确批注、多色高亮、阅读报告、本地书架和多种阅读主题。

## 新版界面

### Windows 桌面端 1.5.2

![阅见 Windows 桌面端 1.5.2 星空主题](docs/screenshots/desktop-v1.4.8.png)

### Android 手机与平板端 1.3.2

<p align="center">
  <img src="docs/screenshots/mobile-v1.2.8.jpg" width="420" alt="阅见 Android 1.3.2 星空主题书架">
</p>

## 直接使用

请前往 [v1.5.0 Release 下载页](https://github.com/ANTARSKYE/yuejian-reader/releases/tag/v1.5.0) 获取正式安装包：

- `Yuejian-Reader-Windows-1.5.0.exe`：Windows 10/11 64 位桌面端。
- `Yuejian-Reader-Android-1.3.0.apk`：Android 8.0 及以上手机和平板端。
- `Yuejian-Reader-Android-1.3.0.aab`：用于提交 Android 应用市场的签名安装包集合，普通用户请下载 APK。
- `Yuejian-Sync-Server.exe`：按需开启的账户与局域网同步服务器。

本地构建后的 Windows 程序位于：

```text
dist/Yuejian-Reader-1.5.2.exe
```

Android 正式安装包构建后位于：

```text
android/release/Yuejian-Android.apk
```

首次使用时，在右上角“AI 设置”中选择服务商、填写模型名称和自己的 API 密钥。密钥使用 Windows DPAPI 加密，只能由当前 Windows 账户解密。

应用服务仅绑定 `127.0.0.1`，每次启动随机选择端口并生成临时访问令牌；接口还会校验 Host、Origin 和同源 Cookie，不向局域网开放。

## 主要功能

- EPUB/TXT 解析、真实目录标题、章节跳转、图片、脚注和基础排版。
- 全文搜索支持检索当前书籍或整个书架，并从结果直接跳到命中的章节。
- 阅读位置历史支持返回/前进，跨章节跳转后也能回到刚才读到的位置。
- EPUB 脚注和外部链接使用阅读页内弹层；目录保留多级结构并按层级缩进。
- 书架支持分类筛选与标签检索，书名、作者、分类、标签和简介均可编辑。
- 长书自适应分块分析、分块结果断点缓存、失败重试和主动取消。
- AI 报告结构校验、完整结果原子保存和二次补充修订。
- 连续滑动和左右翻页，章节可持续衔接。
- 原文选段、精确批注、多色高亮、删除标记和 AI 选段解析。
- 原文选段支持零配置的 MyMemory 联网快速翻译，以及可用自然语言指定风格的 AI 高级翻译。
- 选段可生成与当前主题配色一致的 PNG 阅读书签，预览确认后再保存到本地。
- Windows 书签图片固定保存到“下载/阅见书签”；Android 固定保存到系统相册的“阅见”相册。
- 自动识别 AI 服务商返回的余额或额度不足错误，并明确提示检查计费账户或充值。
- 随书问答会保存为资料议题，支持继续追问、重命名、编辑问答和跨端同步删除。
- 本地书架、封面、阅读进度、日/周/月/年阅读报告。
- 中文维基文库、Project Gutenberg 和自定义书库网站入口。
- 主题、自定义背景、本地头像和名言库。
- 书籍删除、缓存清理、存储统计、完整数据备份/恢复和诊断信息。
- Android 手机、横屏、分屏、中型平板和大屏布局适配。
- 可选账户模式与偶尔在线同步：Windows 按需作为局域网服务器，关闭服务器后各端继续本地使用。
- 多端书架取并集，阅读统计按设备贡献累加；删除书籍、批注和报告会同步删除墓碑。
- 已生成的 AI 报告可跨端查看，接收端无需配置 API 密钥，也不会重复分析。

## 与典型普通阅读器的定位对比

这是一份产品定位对比，不是对每一款商业阅读器的逐项评测。成熟产品可能已经覆盖表中的部分高级能力；阅见的重点，是把阅读、个人知识整理、可控 AI 与本地优先的数据管理放进同一套工作流。

| 对比维度 | 典型普通阅读器 | 阅见 Reader | 阅见的区别与优点 |
| --- | --- | --- | --- |
| 核心定位 | 以打开书籍、翻页、书签和基础标注为主 | 阅读、分析、问答、资料整理与复盘一体化 | 不必在阅读器、聊天工具和笔记软件之间反复切换 |
| 数据与隐私 | 常依赖厂商账户和云端服务 | 默认本地模式；账户同步服务由用户自己的电脑按需开启 | 服务器关闭后仍可完整离线使用，数据控制权更明确 |
| 多端同步 | 通常由厂商云端同步进度和笔记 | 局域网内同步书籍原文、进度、统计、批注、高亮、AI 报告和问答议题 | 已分析结果可直接传到未配置 AI 的设备，并通过删除墓碑保持多端一致 |
| AI 阅读 | 没有 AI，或只提供固定摘要/问答 | 自带 OpenAI、DeepSeek 等模型预选，可使用自己的 API；支持分章深度分析、断点续跑和选段解析 | 模型与费用由用户选择，分析结果本地保存、可补充修订且避免重复生成 |
| 随书问答 | 多为一次性对话，退出后不一定保留 | 问题与回答保存为资料议题，可追问、改名、编辑、删除和同步 | 把零散问答沉淀为可持续整理的阅读资料 |
| 搜索与导航 | 常见书名搜索、目录和单书关键词搜索 | 支持当前书籍/全书架正文搜索、结果直达章节、阅读位置返回/前进和多级目录 | 在大量藏书中快速定位原文，也能回到跳转前的位置 |
| 标注能力 | 书签、批注和单色/有限高亮 | 精确到选中文字的批注、多色高亮、删除、分享书签和跨端同步 | 标注粒度更细，选段可直接转成带书名与时间信息的主题书签图 |
| 翻译 | 常依赖系统菜单或单一内置翻译 | 阅读页内 MyMemory 快速翻译，以及可用自然语言指定风格的 AI 高级翻译 | 原文保持清晰可对照；基础翻译与高质量翻译按需选择 |
| 阅读复盘 | 常见阅读时长、进度或目标 | 日、周、月、年采用不同表达方式呈现节奏、领域和成就 | 不只是把同一组数字更换时间范围，而是帮助发现阅读方向 |
| 书架管理 | 书架、收藏或简单分组 | 分类、标签、筛选、全文检索，以及书名、作者、简介等资料编辑 | 更适合长期维护个人电子书库和处理元数据不完整的 EPUB/TXT |
| 个性化 | 字体、字号、纸张/夜间主题 | 星空、猫咪等图案主题、自定义背景、字体字号和主题联动书签 | 桌面、手机和平板保持统一的视觉体验 |
| 格式与内容生态 | 商业产品通常在书城、DRM、PDF、漫画、听书/TTS 上更成熟 | 当前专注 EPUB/TXT 与个人本地藏书 | 功能边界清晰；不宣称替代商业书城、专业 PDF 工具或有声书平台 |

对比口径参考了 [Apple Books](https://www.apple.com/apple-books/)、[Google Play Books](https://play.google.com/store/apps/details?id=com.google.android.apps.books) 与 [Readwise Reader](https://docs.readwise.io/reader/docs) 的官方功能说明。

## 本机文件位置

- Windows 导入书籍：`%LOCALAPPDATA%\Yuejian\library`
- Windows 分享书签：`%USERPROFILE%\Downloads\阅见书签`
- Android 导入书籍：应用内部存储（由 Android 管理，仅阅见可直接访问）
- Android 分享书签：系统相册 `Pictures/阅见`

软件的“我的/个人资料”页会同时显示这些位置。路径采用固定设置，不再提供修改入口。

## 账户与多端同步

账户功能默认关闭，本地模式不会连接同步服务器。需要更新多端数据时：

1. 双击项目根目录的 `阅见同步服务器.exe`，保持服务器窗口打开。
2. 电脑与手机连接同一局域网或 Wi-Fi；桌面版直接连接本机，安卓版会自动发现服务器。
3. 软件内只需填写用户名和密码：首台设备注册账户，其他设备登录同一账户。
4. 同步完成后可关闭服务器窗口；各设备仍可离线阅读，下次开启服务器后会补传未同步变更。

同步服务器只建议用于可信家庭/办公局域网。首次启动时 Windows 可能询问防火墙权限，请允许“专用网络”。公网使用必须另行配置 HTTPS 或可信隧道。Windows 阅读服务仍只绑定 `127.0.0.1`；独立账户服务器使用 TCP 18787 和 UDP 8788 自动发现。AI API 密钥、登录令牌、本机路径和诊断日志不会进入同步数据。

## 源码运行

支持 Python 3.11–3.13。推荐先执行一次构建脚本，它会自动创建 `.venv` 并安装锁定依赖：

```powershell
.\build.ps1
```

也可以手动运行服务：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe server.py
```

服务启动后会在默认浏览器打开带一次性令牌的本机地址。令牌随即写入 HttpOnly Cookie，并从地址栏移除。

## 测试与构建

运行测试：

```powershell
.\.venv\Scripts\python.exe -m pytest
node --check assets\app.js
```

Android 测试和构建：

```powershell
cd android
.\build-android.ps1
```

桌面版与 Android 版本号集中保存在根目录 `version.json`。Android 正式构建会验证原发布密钥的 SHA-256 指纹，密钥或指纹缺失时主动停止，避免生成无法覆盖升级旧版本的安装包。

一键构建：

```text
构建Windows软件.cmd
```

构建流程会：

1. 自动创建 Python 3.13 虚拟环境。
2. 安装 `requirements-build.txt` 中锁定的依赖。
3. 运行 Python 测试。
4. 使用 PyInstaller 生成单文件 Windows 阅读器及独立同步服务器。
5. 分别运行阅读器和同步服务器的 `--self-test` 验证打包产物。

最终产物固定为：

```text
dist/Yuejian-Reader-1.5.2.exe
dist/Yuejian-Sync-Server.exe
```

## 项目结构

```text
book/
├─ assets/
│  ├─ app.css                 # 页面样式
│  ├─ app.js                  # 阅读器与业务交互
│  ├─ ui-storage.js           # 增量状态同步
│  ├─ accessibility.js        # 弹窗、键盘和 ARIA 行为
│  └─ 图片与图标资源
├─ tests/                     # 解析、安全、备份和并发测试
├─ android/                   # 独立 Android 原生工程与 WebView 阅读界面
├─ docs/screenshots/          # README 项目截图
├─ ai_client.py               # OpenAI/DeepSeek 请求适配与重试
├─ storage.py                 # 跨线程/进程锁与原子持久化
├─ server.py                  # 解析、书架、AI 工作流与本地 API
├─ sync_server.py             # 可按需开启的账户与局域网同步服务器
├─ sync_local.py              # Windows 本地队列、离线续传与数据合并
├─ desktop.py                 # pywebview 桌面入口和单实例控制
├─ index.html                 # 页面结构
├─ pyproject.toml             # 项目与依赖声明
├─ requirements-build.txt     # 可复现构建依赖
├─ build.ps1                  # 完整构建与自测
└─ 构建Windows软件.cmd        # 双击构建入口
```

## 本地数据

数据保存在：

```text
%LOCALAPPDATA%\Yuejian\
```

主要文件包括：

- `library/`：书籍、封面。
- `library.json`：书架索引。
- `analysis-cache.json`：完整 AI 报告。
- `analysis-chunks.json`：可续跑的分段笔记。
- `analysis-timings.json`：匿名本机耗时样本。
- `ai-config.secure.json`：DPAPI 加密的 AI 设置。
- `ui-state.json`：主题、头像、批注、进度和阅读报告数据。
- `logs/`：轮转诊断日志。

“导出备份”会包含书籍、阅读数据和分析缓存，但不会导出 API 密钥、日志或 WebView 缓存。

## 数据可靠性与兼容

- JSON 数据采用跨线程/进程锁、唯一临时文件和原子替换。
- 阅读统计和批注使用书籍 SHA-256 标识；旧版按书名保存的数据会在首次打开时自动迁移。
- 会话有数量上限和空闲过期时间，避免长时间运行造成内存持续增长。
- 损坏备份、超大压缩包、异常 EPUB 和非图片书内资源会被拒绝。

运行要求：Windows 10/11 64 位及 Microsoft Edge WebView2 Runtime，或 Android 8.0 及以上。AI 和在线书库功能需要联网。请只处理有权阅读和分析的内容。
