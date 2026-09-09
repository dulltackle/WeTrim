# 微信公众号文章手动清洗 Web 工具

在 https://github.com/jackwener/wechat-article-to-markdown 基础上开发，实现对爬取到的文章内容进行手动清洗（选择保留/剔除段落与图片），并最终导出 zip 包。

## 已确认方案

### 1. 架构

- 上游 Python CLI（`wechat-article-to-markdown`，Camoufox 反检测抓取）**继续负责抓取**，逻辑不改动。
- 本工具是它的**前端配套**：一个**零依赖 Node.js 本地服务**，负责
  - 静态页面托管；
  - 监听 `output/` 目录并推送更新；
  - 收到粘贴的 URL 后 shell 调用上游 CLI 抓取（需本机已装 `wechat-article-to-markdown`）。

### 2. 流程

1. 页面顶部粘贴微信公众号 URL → 服务调 CLI 抓取到 `output/` → 页面自动加载该篇；
2. 也可手动跑 CLI，watcher 检测到新产物后自动刷新；
3. 清洗完成后，浏览器端打包并导出 zip。

### 3. 清洗能力

- 每个内容块（段落 / 标题 / 图片 / 代码块 / 列表 / 引用…）一个「保留 / 剔除」开关；
- 图片带**缩略图预览**，剔除后该图不进 zip、md 内引用一并移除；
- 段落支持**就地编辑 Markdown 源码**（文本框）；
- 不做拖拽排序。

### 4. 界面形态

- 单栏块列表：段落为可编辑文本框、图片为缩略图 + 开关；
- 顶部「预览」开关：渲染效果 / 原始 Markdown 一键切换；
- 顶部「粘贴 URL」输入框为主入口；
- 精简「已抓取文章」侧栏：自动列出 `output/` 下所有文章、高亮刚抓取的那篇，用于重新打开。

### 5. 导出

- 单篇一个 zip（一次处理一篇）；
- 内部结构：`<标题>/<标题>.md` + `<标题>/images/…`；
- md 顶部带 YAML front-matter：`title / 公众号 / date / source`；
- zip 由浏览器端 JSZip 生成，图片以 blob 拉取。

### 6. 技术栈

- 前端：纯 HTML / CSS / JS，无框架、无构建步骤；
- 后端：零依赖 Node.js（`fs.watch` + `http`），不包含抓取/反检测逻辑。

## 测试文章 URL

- https://mp.weixin.qq.com/s/4oW2sWIYTpoTc58FhQWWhQ
- https://mp.weixin.qq.com/s/q8otur4qi_-6Gc13vBE7ZQ
- https://mp.weixin.qq.com/s/pKl5Ku7C50eUnBUAmPNf5A

---

1. https://mp.weixin.qq.com/s/bFIyu9ssse5vOqi6sEHVYw
2. https://mp.weixin.qq.com/s/8EIed5cmXFIB2uqxDg3CYg
3. https://mp.weixin.qq.com/s/l-CVnH-C0hO4nTQX1MNa4g