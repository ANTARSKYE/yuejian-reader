# 阅见 Reader

一款在 Windows 本地运行的 AI 电子书阅读器。支持 EPUB、TXT 阅读、分章 AI 深度分析、批注标红、阅读报告、本地书架和多种阅读主题。

## 快速使用

1. 双击 [`dist/reader.exe`](dist/reader.exe)。
2. 点击右上角“AI 设置”，选择服务商、模型并填写自己的 API 密钥。
3. 上传 EPUB 或 TXT，书籍会自动加入本地书架。
4. 点击右上角用户入口，可设置完整显示名称或上传头像；有头像时顶部优先只显示图片。

软件启动时由 Windows 自动选择空闲的内部端口，仅绑定 `127.0.0.1`。端口不会显示，也不会向局域网或互联网开放。

## 主要功能

- EPUB/TXT 真实解析、目录与章节跳转。
- 长书按章节自适应分段分析，再汇总为完整深度报告。
- AI 分析缓存与主动“二次解析：补充与修订”。
- 原文选段、标红、本地批注和 AI 选段解析。
- 字体、字号、经典绿、星空、猫咪等主题及自定义背景。
- 本地书架、封面展示和阅读进度恢复。
- 日、星期、月、年四个尺度的独立阅读报告。
- 中文维基文库、Project Gutenberg，以及随软件提供的“安娜的档案”“Z-Library”网页跳转和自定义网站链接。外部链接不参与自动下载，请自行确认资源版权。
- 本地用户名/图片头像、名言库、固定/随机名言和多作者名言批量导入；复杂批量格式可调用已配置的 AI 辅助拆分。

## 项目结构

```text
book/
├─ dist/
│  └─ reader.exe             # 可直接分发和运行的 Windows 软件
├─ assets/
│  ├─ q-star-sky.png         # “星空”主题背景
│  ├─ q-cat-reading.png      # “猫咪”主题背景
│  └─ yuejian.ico            # Windows 软件图标
├─ .desktop-venv/            # 构建 EXE 使用的独立 Python 环境
├─ index.html                # 软件界面、阅读器和前端交互逻辑
├─ server.py                 # EPUB/TXT 解析、AI、书架与在线书库服务
├─ desktop.py                # Windows 窗口入口和自适应本机端口
├─ 构建Windows软件.cmd        # 一键重新生成 dist/reader.exe
├─ 启动阅见.cmd               # 以网页调试方式启动源码
├─ .gitignore                # Git 忽略规则
└─ README.md                 # 项目说明
```

`.git/` 是版本历史；`.desktop-venv/` 不是运行 `reader.exe` 所必需，但一键构建脚本依赖它，因此应保留。

## 本地数据

用户数据不放在项目目录，而保存在：

```text
%LOCALAPPDATA%\Yuejian\
```

其中包括：

- `library/`：上传或下载的 EPUB/TXT 与封面。
- `library.json`：本地书架索引。
- `analysis-cache.json`：AI 分析与修订结果。
- `analysis-timings.json`：按模型学习的分析耗时记录。
- `ai-config.secure.json`：由 Windows DPAPI 加密的 API 设置。
- `webview/`：用户名、主题、名言、批注和阅读统计等界面数据。

将 `reader.exe` 发给别人不会附带你的 API 密钥、书籍或阅读记录。对方首次启动后会建立自己的数据目录。

## AI 与长书分析

软件支持 OpenAI 与 DeepSeek 兼容接口。长书不会一次性塞入模型，而会根据正文长度、章节结构、复杂度和所选模型，自适应决定分块大小与调用次数；各块先形成章节笔记，再生成全书报告。

分析成功后会保存结果。再次打开同一本书不会重复调用 AI；只有用户主动选择二次解析时，才会参考旧报告补充、纠错和重组。

API 密钥通过 Windows DPAPI 绑定当前 Windows 账户加密保存，不写入 EXE，也不以明文放在项目目录。

## 重新构建 Windows 软件

双击：

```text
构建Windows软件.cmd
```

生成结果：

```text
dist/reader.exe
```

构建过程会临时生成 `build/` 和 `reader.spec`。它们可以安全删除，不影响已经生成的 EXE；`.gitignore` 已将这些文件排除。

也可先运行源码：

```powershell
python server.py
```

## 运行要求

- Windows 10/11 64 位。
- Microsoft Edge WebView2 Runtime（多数 Windows 10/11 已自带）。
- AI 分析与在线书库功能需要联网。
- 支持 `.epub`、`.txt`，单本最大 30 MB；暂不支持 MOBI。

请仅处理你有权阅读和分析的书籍，并根据所在地版权规则使用在线资源。
