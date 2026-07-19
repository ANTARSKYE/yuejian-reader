# 阅见 Android

这是与 Windows 桌面版完全隔离的 Android 原生工程。Android 端数据保存在应用私有目录，不读取或修改桌面版的 `%LOCALAPPDATA%\Yuejian` 数据。

## 已实现

- EPUB / TXT 文件选择、系统分享打开和离线导入
- 本地书架、章节目录、上下章切换、阅读进度
- 全文搜索、阅读位置前进/后退、分级目录、脚注与链接阅读页内弹层
- 书架分类与标签筛选、书名/作者/分类/标签/简介编辑及账户同步
- EPUB 图片资源显示、TXT 中文编码识别和自动分章
- 纸张、护眼、纯白、夜间主题，以及字号和行距
- 章节书签、返回键处理、平板自适应布局
- EPUB 路径穿越、XML 外部实体和解压体积保护
- DeepSeek / OpenAI 设置、Android Keystore 密钥保护、分段分析缓存、全书深度报告、随书问答和选段解析
- 批注、标红、已读章节、日/周/月/年阅读报告和估算字数
- Project Gutenberg 搜索下载、中文维基文库及自定义书源入口
- 本地档案、头像、背景、六套主题、字体和名言库
- 存储统计、分析缓存清理、ZIP 备份恢复
- `yuejian-sync-v1` Outbox 与账户服务器接口契约（当前默认本地模式）
- 紧凑手机、横屏、折叠/分屏、中型平板和大屏三栏布局

## 构建

在 PowerShell 中运行：

```powershell
.\build-android.ps1
```

脚本只接受已经备份并固定指纹的正式发布证书，不会在证书缺失时擅自生成新密钥。构建前需恢复：

```text
tools\release.keystore
tools\release-keystore.sha256
```

签名密码通过环境变量 `YUEJIAN_KEYSTORE_PASSWORD` 提供，也可使用仅保存在本机的 `tools\release-password.txt`。验证通过后输出经过 zipalign 和 APK v2/v3 签名的正式安装包：

```text
release\Yuejian-Android.apk
release\Yuejian-Android-<版本>.aab
```
