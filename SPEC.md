# WeTrim v1 技术方案：Chrome / Edge 浏览器扩展

## 0. 这份文档是什么

WeTrim v1 的完整技术方案，写到可以直接开工的程度：架构、权限、流程、数据结构、消息协议、存储契约、验收样例，以及实现期必须补测的清单。

它是[地图：把 WeTrim 从本地服务改造成浏览器扩展](https://github.com/dulltackle/WeTrim/issues/1)的终点产物，由[整合票](https://github.com/dulltackle/WeTrim/issues/8)整合 11 张已关决策票的结论而成。**每一节都标注来源票**：对本文档某条规则有疑问时，去那张票的解决评论找完整论证，本文档不重述论证过程。

### 怎么读

| 文档 | 管什么 |
| --- | --- |
| `SPEC.md`（本文档） | 架构、流程、数据结构、契约 |
| [`docs/conversion-rules.md`](./docs/conversion-rules.md) | 微信 HTML → Markdown 的逐条规则清单 |
| [`CONTEXT.md`](./CONTEXT.md) | 领域词汇表。本文档出现的**加粗术语**以它为准，不在这里重新定义 |
| [`docs/adr/`](./docs/adr/) | 七条架构决策记录。本文档引用它们，不重述 |
| [`docs/research/`](./docs/research/) | 调研与实测笔记，含全部原始数字和验证边界 |

`mvp.md` 已删除。它整份建立在「上游 Python CLI 的前端配套 + 零依赖 Node 本地服务」这个前提上，随架构改换全部作废。

### 一条贯穿全文的纪律

本文档区分**已决定**、**已实测**、**尚未验证**三件事，并且从不混用。第 12 节集中列出「现在不得当作已验证」的全部条目，正文中相应位置也会就地标注 ⚠️。这不是谨慎的修辞——地图推进过程中已经有两次推论被后续实测推翻（content script 的 CORS、「上界 ≈ 300 块」），本文档的价值一半在于不让第三次发生。

---

## 1. 定位与架构

### 1.1 产品定位

自包含的 Chrome / Edge 浏览器扩展，单独一份 MV3 包，上架 Chrome Web Store。**不是任何 CLI 的前端配套**，不依赖本机安装 Python、Node 或任何服务。

目标用户是完全不懂技术的人。「零安装门槛」是唯一的硬约束，其余选择都从它推出来。

浏览器扩展这个形态本身的理由——反爬风险归零、商店一键安装、分发成本 $5 一次性——见地图的基线决策第 1 条。

### 1.2 三个执行上下文与职责

MV3 扩展有三处可以跑代码。职责划分如下，**边界是硬的**：

| 上下文 | 做什么 | 明确不做什么 |
| --- | --- | --- |
| **content script**<br>（注入文章页） | 判定页面状态（三档）；内容稳定探测；取 `#js_content` 的 `outerHTML`；取标题、公众号名、发布时间戳 | 不切块、不转换、不 fetch 图片、不写 storage |
| **service worker**<br>（后台） | 响应 `action.onClicked`；`executeScript` 注入；把结果写进 `pendingCapture`；打开/聚焦扩展全页；单实例仲裁 | 不解析 HTML、不转换、**不经手任何图片字节** |
| **扩展全页**<br>（`chrome-extension://…/app.html`） | 解析、切块、转换；全部清洗界面；持久化读写；fetch 图片；写磁盘 | 不注入文章页 |

三条边界各自的取舍：

- **切块与转换在扩展全页，不在 content script。** content script 每次点击都要注入，把切块器 + Turndown + GFM 插件打进注入包等于在用户正在阅读的文章页上执行一大坨代码。`DOMParser.parseFromString` 重建的 DOM 不执行脚本、不加载资源，但保留全部属性（`data-src`、`data-miniprogram-title`、`list-paddingleft-N`、第三方代码块的内联 `user-select: none`），对我们已定的全部判据没有信息损失。解析失败的判定与提示因此落在同一个上下文里，不用跨进程搬错误。
  - ⚠️ 唯一放弃的是**计算样式**——扩展全页读不到它。已定的全部判据（行内/独立公式看父元素结构、第三方代码块行号看内联样式、富媒体看标签与属性）都不需要它。若实现期出现只能靠计算样式识别的结构，届时让 content script 额外带一小份过来，代价不大。
- **图片字节由扩展全页自己 fetch，service worker 不中转。** 写磁盘用的 `FileSystemDirectoryHandle` 只存在于扩展全页；service worker 抓到字节还得送回来，而 MV3 的 runtime messaging 走 JSON 序列化，`ArrayBuffer` 传不过去，必须 base64，体积膨胀约三分之一。[#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 实测那篇 6 张 PNG 共 9.5 MB 的深度长文，转 base64 约 12.6 MB，还要多两次编解码。[#4 的实测](https://github.com/dulltackle/WeTrim/issues/4#issuecomment-5573273170)中扩展全页是被测的五个上下文之一，45 次请求全部 200。
  - ⚠️ 该实验全程在已声明 `host_permissions` 的 manifest 下运行，**没有移除权限的对照组**。不得据此删掉 `host_permissions`。
- **清洗期的缩略图不走 fetch。** 直接把**图片资源**的远程 URL 放进 `<img src>`；`<img>` 标签本就不受 CORS 约束。取图片字节只发生在导出时。

### 1.3 数据流总览

```
用户在文章页点扩展图标
  │
  ▼
service worker: action.onClicked
  │  chrome.scripting.executeScript(注入 content script)
  ▼
content script: 判定 → 稳定探测 → 取 outerHTML + 元数据
  │  返回 CaptureResult（见 §3.3）
  ▼
service worker: 把 CaptureResult 写进 storage 的 pendingCapture
  │  打开或聚焦扩展全页；若已打开，发一条不带数据的叫醒消息
  ▼
扩展全页: 读 pendingCapture → 立即删除该 key
  │
  ├─ kind !== 'article' ──▶ 按 §3.1 的三档口径提示，不动 currentSession
  │
  ▼ kind === 'article'
解析 → 切块 → 逐块转换  ──失败(整篇级)──▶ 通用提示 + 重试，不写候选
  │
  ▼ 得到 ArticleSnapshot
写入 candidateSnapshot（先落盘）
  │
  ├─ 无 currentSession ──▶ 直接提升为当前**清洗会话**
  └─ 有 currentSession ──▶ 弹替换确认框（此时所有会失败的事都已发生完）
  │
  ▼
清洗：逐块保留/剔除、编辑、还原（自动保存进 currentSession）
  │
  ▼
导出：选父目录 → 从保留块当前内容算图片引用 → fetch 图片 → 写目录
```

关键性质：**每一步的失败都不会破坏已有的清洗会话**。这不是巧合，是 [#7](https://github.com/dulltackle/WeTrim/issues/7#issuecomment-5582245317) 和 [#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 共同约束出来的顺序：先落盘，再问；获取、解析、保存全部成功之后，确认那一下才只是把**候选快照**提升为当前会话。

### 1.4 技术栈

| 用途 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | Vite + TypeScript | MV3 的 CSP 禁远程脚本与 `eval`，第三方库必须打包 |
| 界面 | React 19 | |
| HTML → Markdown | Turndown + `turndown-plugin-gfm` | 表格支持来自 GFM 插件 |
| Markdown 预览 | marked + DOMPurify | 沿用 [#11 探针](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026)与 [#9 原型](https://github.com/dulltackle/WeTrim/issues/9#issuecomment-5594805365)的组合 |
| 状态管理 | `useReducer` + Context，无外部 store | 见 §6.2 |
| 打包/压缩 | 无 | ZIP 方案随 [#6](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012) 作废，JSZip 不引入 |

⚠️ 上述四个第三方库的生产构建**是否完全不依赖 `eval`，尚未实测**。CSP 违规在扩展里是静默失败，极难排查，实现期第一件事就该验证（见 §12）。

### 1.5 源码目录结构

```
src/
├── manifest.json
├── background/
│   ├── index.ts           # service worker 入口，action.onClicked
│   ├── capture.ts         # executeScript 调用，CaptureResult 落盘
│   └── app-tab.ts         # 打开/聚焦扩展全页，单实例仲裁
├── content/
│   └── capture.ts         # 注入脚本：三档判定、稳定探测、取 HTML 与元数据
├── app/                   # 扩展全页
│   ├── main.tsx
│   ├── App.tsx            # 顶层状态机：空 / 清洗 / 候选确认 / 损坏记录
│   ├── state/
│   │   ├── session-reducer.ts    # 唯一的会话 reducer
│   │   ├── session-context.tsx
│   │   └── persistence.ts        # 写入队列、防抖、revision 校验
│   ├── parse/
│   │   ├── split-blocks.ts       # 切块
│   │   ├── convert.ts            # Turndown 实例装配
│   │   └── rules/                # 逐条微信规则，对应 docs/conversion-rules.md
│   ├── components/
│   │   ├── BlockList.tsx         # 全部块的唯一渲染入口（见 §6.2）
│   │   ├── BlockItem.tsx
│   │   └── …
│   ├── export/
│   │   ├── collect-images.ts     # 从保留块当前内容算有效图片引用
│   │   ├── fetch-images.ts
│   │   ├── build-markdown.ts
│   │   └── write-directory.ts
│   └── preview/
│       └── render.ts             # marked + DOMPurify
└── shared/
    ├── types.ts           # Session / Block / ImageAsset / CaptureResult
    ├── storage-keys.ts
    └── messages.ts
```

---

## 2. 权限清单

来源：[#3 MV3 权限模型与 Chrome Web Store 审核约束](https://github.com/dulltackle/WeTrim/issues/3)。

```json
{
  "manifest_version": 3,
  "name": "WeTrim",
  "version": "1.0.0",
  "description": "手动清洗微信公众号文章，导出 Markdown 和图片。",
  "action": {
    "default_title": "用 WeTrim 清洗这篇文章"
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage", "unlimitedStorage"],
  "host_permissions": ["*://mmbiz.qpic.cn/*", "*://mmbiz.qlogo.cn/*"],
  "icons": { "16": "…", "48": "…", "128": "…" }
}
```

| 条目 | 理由 | 安装警告 |
| --- | --- | --- |
| `activeTab` | 用户点击图标后临时获得当前标签页主框架的主机权限，正好匹配唯一的入口设计（[ADR-0006](./docs/adr/0006-single-entry-from-article-tab.md)） | **无** |
| `scripting` | 调用 `executeScript` 所需 | **无** |
| `storage` | 持久化**清洗会话** | **无** |
| `unlimitedStorage` | 解除 `storage.local` 的 10 MiB 默认配额 | **无** |
| `host_permissions` | 扩展全页跨域 fetch **图片资源** | 「读取和更改你在 mmbiz.qpic.cn、mmbiz.qlogo.cn 上的数据」 |
| ~~`downloads`~~ | **不声明**。用 File System Access API 写盘，它不需要任何权限声明 | 避开了「管理您的下载内容」 |
| ~~`tabs`~~ | **不声明**。判定页面是否可读靠「尝试注入并捕获失败」；`chrome.tabs.create` / `chrome.tabs.update` 不需要该权限 | — |
| ~~`declarativeNetRequestWithHostAccess`~~ | **暂不声明**。[#4](https://github.com/dulltackle/WeTrim/issues/4#issuecomment-5573941622) 实测未主动注入 `Referer` 也能下载成功 | — |

**用户在安装时只会看到一条警告**，来自 `host_permissions`。

几条不能忘的约束：

- **不为 `mp.weixin.qq.com` 声明 `host_permissions`。** 正文读取只靠 `activeTab`。[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 取消了加这个域名的全部功能性理由；是否为了「警告里出现用户认识的域名」而顺带写上，纯属上架期的观感取舍，功能上两种都可行，本方案按功能最小集写。
- **CSP 不放宽。** MV3 默认的 `script-src 'self'; object-src 'self'` 原样保留。禁远程脚本、内联脚本、`eval`、WebAssembly。
- **禁止代码混淆**（商店规则）。
- **上架材料**：隐私政策 URL、数据收集披露与有限使用认证必须提交，**逾 30 天不填会被下架**。首次提交会命中「新开发者 + 新扩展」的审核拖慢信号，要预留时间。图标、商店截图、权限用途说明属于上架素材，不在本方案范围内。

---

## 3. 主流程

### 3.1 入口与页面判定

来源：[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811)、[ADR-0006](./docs/adr/0006-single-entry-from-article-tab.md)。

**v1 只有一个文章入口**：用户在自己已打开的公众号文章标签页上点击扩展图标。**不提供粘贴 URL 的入口**——粘贴意味着扩展要自己去取页面，等于把上游背着 Camoufox 的那条反爬赛道原样请回来（2026-09-11 实测：一个格式合法的 `__biz` 链接在无任何用户交互下被 302 到验证页）。

content script 注入后只承认**三档判定**，按可靠性排列：

| 档 | 判据 | 行为 |
| --- | --- | --- |
| 1. 正常文章页 | 能注入且 `#js_content` 存在 | 进入抓取 |
| 2. **微信提示页** | 能注入、无 `#js_content`、有 `.weui-msg` 且 `.weui-msg__title` 文案非空 | **原样转述微信给出的那句中文**，配「回到原文看看」与「重试」 |
| 3. 通用失败 | 其余全部情况 | 统一提示「这个页面上没找到公众号文章正文」 |

第 3 档覆盖：注入失败（`chrome://`、网上应用店、其他扩展页等受限页面）、非微信页面、微信的非文章页面、验证页首屏。**不猜**是删除、违规还是需要登录。

两条写死的规则：

- **判定逻辑不得匹配具体文案**，只判断 `.weui-msg__title` 是否存在且非空。⚠️ 原因见 §12：真实观察到的提示文案**只有「参数错误」一种**，其余文案落在同一模板里是基于模板一致性的推断，无样本。
- **验证页**（URL 路径 `/mp/wappoc_appmsgcaptcha`）是第 3 档里唯一单独给路径的子情况：提示用户回到原文页面自行完成验证，完成后再点图标。**不代替用户完成验证。**

**在读不了的页面点图标时**：照常打开/聚焦扩展全页，**不做「什么都不发生」**——点了没反应对零基础用户等同于扩展坏了。有旧**清洗会话**就直接显示它继续清洗，顶部给一条**非模态**提示「刚才那个页面上没有公众号文章，你的进度没有被动过」；没有旧会话就是空状态 + 同一条提示。**不弹替换确认框**，因为没有**候选快照**可替换。

**空状态**明确写出三步：用浏览器打开一篇公众号文章 → 等它显示完 → 点工具栏上的 WeTrim 图标。不把「没有文章」呈现成错误。

### 3.2 内容稳定探测

- 点击后**立即读一次 DOM**。`#js_content` 不存在即按三档判定处理。
- `#js_content` 存在时做一次稳定性探测：正文文本长度与 `img[data-src]` 数量在约 **300 ms** 内不再增长即认为稳定，**最多等约 2 秒**。
- 超时则按当前拿到的内容继续，并在扩展全页顶部提示「文章可能还没显示完整，可以回到原文等它加载完再重新抓一次」。**不假装抓全了**（`CaptureResult.unstable = true` 承载这个信号）。
- 不采用上游的固定 2 秒 sleep：[#2](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738) 已查明微信把图片真实地址预写进 `data-src`、**不需要模拟滚动**，且用户通常是看着页面显示完才点图标。

⚠️ **300 ms / 2 秒这两个阈值尚未实测**，是依据「真实地址预写进 `data-src`」所做的设计，实现期需在真实文章上校准。

### 3.3 抓取载荷与传递

content script 的返回值是一个可辨识联合：

```ts
type CaptureResult =
  | { kind: 'article'; source: ArticleSource; contentHtml: string; unstable: boolean }
  | { kind: 'wechatNotice'; noticeText: string }
  | { kind: 'captcha'; articleUrl: string | null }
  | { kind: 'noArticle' };
```

`executeScript` 本身 reject（受限页面注入失败）时，service worker 合成 `{ kind: 'noArticle' }`——**失败本身即信号**，这正是不申请 `tabs` 权限的原因。

service worker 拿到 `CaptureResult` 之后：

1. 写进 `storage.local` 的 `pendingCapture` key（连同 `capturedAt`）；
2. 打开或聚焦扩展全页；
3. 若扩展全页**已经开着**，发一条 `{ type: 'pending-capture' }` 消息——**不带数据，只叫醒**。

扩展全页在启动时、以及每次收到叫醒消息时，读 `pendingCapture`，**立即删除该 key**，再按 `kind` 分派。

**为什么走 storage 而不是直接发消息。** service worker 随时会被回收，扩展全页刚打开时还没准备好接消息；直接发消息要求两边同时活着且就绪，这是个时序赌博，失败模式在开发机上几乎不出现、在用户的旧电脑上才出现。走 storage 之后，谁先谁后完全不影响正确性。这跟 [#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 给候选快照定「先落盘，再问」是同一条理由。

**为什么不让 content script 直写 storage。** 页面判定用的是「尝试注入并捕获失败」，这个判定在 service worker 手里；让 content script 直写会把成功路径和失败路径分到两个上下文里，而且它写完之后 service worker 仍然得知道——又绕回通知问题。

体积：最大那篇正文 HTML 为 295.7 KB（[#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 实测），远低于配额。

**完整的消息协议就这一条**：`service worker → 扩展全页: { type: 'pending-capture' }`。扩展全页不需要向 service worker 请求任何东西——`chrome.tabs.create`（「回到原文看看」）和 File System Access 都能在扩展全页直接调用。协议小是刻意的：跨上下文的每一条消息都是一处时序假设。

### 3.4 解析、切块与转换

在扩展全页里：

1. `new DOMParser().parseFromString(contentHtml, 'text/html')` 重建 DOM；
2. 按 [ADR-0001](./docs/adr/0001-content-block-boundaries.md) 与 [#5](https://github.com/dulltackle/WeTrim/issues/5#issuecomment-5581555371) 的规则切出**内容块**；
3. 每块**独立**转换成 Markdown（见 §5 与 [ADR-0007](./docs/adr/0007-per-block-conversion.md)）；
4. 组装 `ArticleSnapshot`。

### 3.5 候选快照与替换确认

来源：[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811)、[#7](https://github.com/dulltackle/WeTrim/issues/7#issuecomment-5582245317)。

- **先落盘，再问。** `ArticleSnapshot` 先写进 `candidateSnapshot`（与 `currentSession` 分开的固定 key），**写入成功之后**才弹替换确认框。这样所有可能失败的事都发生在确认框之前，确认那一下只是把候选提升为当前会话。
- **无旧会话时不弹确认**，直接进入清洗。确认框的唯一目的是保护已有进度。技术上仍走同一条「先落盘再启用」的路径。
- **等待确认期间原标签被关闭或导航走：不做任何处理。** 候选已不依赖那个标签；只有「回到原文」需要用保存下来的 URL 新开标签。
- **重复点击与换文章**：
  - 抓取进行中再点 → 忽略，只聚焦扩展全页，不并发抓两次。
  - 已有候选且是**同一 URL** → 不重抓，聚焦扩展全页并把已有确认框摆回来。
  - 已有候选但是**另一篇** → 新候选覆盖旧候选，确认框换成新那篇。候选不承载用户劳动，覆盖无损失。
  - **候选永远不会自动提升为当前会话。**
- **候选未处理就关闭扩展全页 → 丢弃候选**，下次打开直接恢复旧会话。
- **候选写盘失败** → 不弹确认，报未完成并保留旧会话。
- 同一文章重新抓取与换另一文章遵循**相同**的确认规则：新抓取产生新 `snapshotId` 和新**块身份**，**不匹配也不迁移旧编辑**（[ADR-0002](./docs/adr/0002-restore-snapshot-block-identity.md)）。

### 3.6 单实例保证

[#7](https://github.com/dulltackle/WeTrim/issues/7#issuecomment-5582245317) 要求：只允许一个有效编辑页；手动复制标签、连续点击或浏览器恢复出多个页面时也必须成立；**不能仅靠 service worker 内存里的 tabId 作为跨重启保证**。

做法：

- service worker 打开扩展全页前，用 `chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')] })` 查是否已有同类页面——这查的是**浏览器实时状态**，不是 service worker 内存，因此跨 worker 重启有效。已有就 `chrome.tabs.update({ active: true })` 聚焦，不新开。
- 扩展全页**自己也要查一次**：启动时同样调用 `getContexts`，若发现不止一个同类页面（用户手动复制标签、浏览器会话恢复），则按确定规则选一个为写入方（例如 `documentId` 最小者），其余进入只读态并提供「切换到正在编辑的页面」。
- 只读态的页面不写 storage，也不显示保存状态。

---

## 4. 块模型与数据结构

概念定义在 [`CONTEXT.md`](./CONTEXT.md)，切块边界在 [ADR-0001](./docs/adr/0001-content-block-boundaries.md)，完整论证在 [#5](https://github.com/dulltackle/WeTrim/issues/5#issuecomment-5581555371)。这里只给数据结构。

```ts
// ---- 块 ----

type BlockType =
  | 'paragraph' | 'heading' | 'image' | 'code' | 'list' | 'quote'
  | 'table' | 'divider' | 'formula' | 'richMedia' | 'unknown';

/** 转换提示：转换降级或信息丢失时给用户看的辅助信息。不进入导出正文。 */
interface ConversionNote {
  code: string;        // 机器可读，如 'table-degraded' | 'richmedia-placeholder' | 'convert-failed'
  message: string;     // 面向用户的中文说明
  imageAssetIds?: string[];  // 与提示相关的图片资源
}

interface Block {
  id: string;                      // UUID，首次切分时生成
  order: number;                   // 顺序单独保存，不用数组下标当身份
  type: BlockType;                 // 初始类型，编辑不改变，也不重新切块
  originalHtml: string;            // 来源记录，不是可直接执行的页面
  initialMarkdown: string;         // 首次转换结果，永不变
  editedMarkdown: string | null;   // null = 未编辑；'' 是有效编辑
  included: boolean;               // 保留 = true
  notes: ConversionNote[];
  headingLevel?: number;           // type === 'heading' 时
}

/** 当前内容 */
const currentMarkdown = (b: Block) => b.editedMarkdown ?? b.initialMarkdown;
```

**`editedMarkdown` 必须用 `?? ` 而不是 `||`。** 空字符串是有效编辑，用真假值回退会让「用户清空一个块」变成「恢复初始内容」。这是个会安静生效很久的 bug。

```ts
// ---- 图片 ----

/** 图片资源。与图片块分开建模：一张图可被多个块引用。 */
interface ImageAsset {
  id: string;
  url: string;        // 完整原始 URL（data-src 优先于 src），已按文章 URL 解析为绝对地址
}
```

本地文件名、缩略图、下载结果都是**派生信息**，不进 `ImageAsset`，也不能充当块身份。导出时的本地文件名属于导出映射，见 §7。

```ts
// ---- 快照与会话 ----

interface ArticleSource {
  title: string;            // 原始标题，文件名清理不反写这里
  account: string | null;
  publishedAt: string | null;  // 'YYYY-MM-DD'，UTC+8 换算，无法可靠解析则 null
  url: string;              // 原样保存，不为会话身份删改微信查询参数
}

interface ArticleSnapshot {
  snapshotId: string;
  capturedAt: string;       // ISO
  source: ArticleSource;
  blocks: Block[];
  images: ImageAsset[];
  captureWarnings: ConversionNote[];   // 如「可能没显示完整」
}

interface Session {
  schemaVersion: number;
  sessionId: string;
  snapshot: ArticleSnapshot;
  revision: number;         // 单调递增，防迟到写入覆盖新状态
  savedAt: string;
}

interface CandidateRecord {
  schemaVersion: number;
  snapshot: ArticleSnapshot;
  savedAt: string;
}

interface PendingCapture {
  capturedAt: string;
  result: CaptureResult;
}
```

**不额外保存整篇原始 HTML**：每块保存自己那段 `originalHtml` 就够，不为每个块复制整篇（[ADR-0004](./docs/adr/0004-restore-session-without-image-cache.md)）。

**每块常驻三份文本不削减**（`originalHtml` / `initialMarkdown` / `editedMarkdown`）。[#11](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026) 实测 600 块整份载荷 473 KB、JS 堆全程个位数 MB，与图片解码的约 200 MB 差三个数量级；为省这点而给同步的还原交互引入异步读取路径，是拿确定的复杂度换不存在的收益。

---

## 5. HTML → Markdown 转换

逐条规则清单在 [`docs/conversion-rules.md`](./docs/conversion-rules.md)。本节只定架构与失败处理。

### 5.1 基座与一条硬约束

Turndown 作为基座，`turndown-plugin-gfm` 提供表格，再加一组微信专用 rule。Turndown 真正提供的价值是行内格式、链接、Markdown 特殊字符转义，以及「未知标签去标签留内容」这个默认行为——后者正好等价于 [#2](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738) 里 markdownify 对微信那堆嵌套 `<section>` / `<span style>` 达成的效果，因此**不需要写任何「拍平嵌套 section」的代码**。

**硬约束：每个内容块独立转换，绝不「整篇拼接后再回填占位符」。** 见 [ADR-0007](./docs/adr/0007-per-block-conversion.md)。上游正是栽在这里——占位符 `CODEBLOCK-PLACEHOLDER-1` 是 `-10`…`-19` 的前缀，顺序 `str.replace()` 会把它们吃掉，一篇 40 个代码块的文章只有前 10 个存活。按块转换让整个 bug 类别不存在，但**前提是不要重新引入占位符方案**。

### 5.2 转换失败的两档处理

[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 定了「注入成功但切块失败 → 通用提示 + 重试，不写候选」，但没区分整篇与单块。这里补齐：

| 档 | 触发条件 | 行为 |
| --- | --- | --- |
| **整篇级** | 拿不到 `#js_content`；HTML 文本解析不出 DOM；切块器整体抛错 | 按 §3.1 第 3 档走通用提示 + 重试。**不写 `candidateSnapshot`，不动 `currentSession`** |
| **单块级** | 某块转换抛错；或**原始 HTML 非空却转出空内容** | 该块降级为**未知内容块**：`type = 'unknown'`，`initialMarkdown` 写可读占位说明，挂一条 `code: 'convert-failed'` 的**转换提示**。**候选照常写入** |

**为什么必须分两档。** [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 那篇深度长文有 347 个块。若任何转换异常都算整篇失败，一个没见过的结构就让整篇清洗不了，而用户看到的还是「这个页面上没找到公众号文章正文」加一个重试按钮——重试还是同一篇、同一个结构，永远失败。用户没有出路，提示还是错的。

**第二条触发条件（非空 HTML 转出空）不是凑数的。** [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 记录过一个真实案例：切块器把公众号名片整个丢掉了——那张卡片没有文本节点、没有 `img` 子节点，全部内容在属性里，用「无块级后代 = 叶子」当穿透判据就会让它静默消失。**不抛错，但内容没了**，这比抛错危险，因为没人会发现。所以要主动检查。

这跟已定的姿态一致：[#5](https://github.com/dulltackle/WeTrim/issues/5#issuecomment-5581555371) 要求「不以空字符串静默丢失」，[#6](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012) 要求「不伪造信息，也不使用空字符串掩盖内容丢失」。

### 5.3 预览与导出共用一套方言

预览与导出使用**同一套** Markdown 方言、**当前内容**、保留状态、表格降级和富媒体占位规则。预览展示安全渲染（marked + DOMPurify）后的结果并提示降级，导出保留相应 Markdown 源码。**唯一差异是图片 URL 到本地路径的映射**，那是导出副本才有的。

预览不承诺与每一种外部 Markdown 阅读器像素一致。

---

## 6. 清洗界面

来源：[#9 的解决结论](https://github.com/dulltackle/WeTrim/issues/9#issuecomment-5594805365)。原型资产归档在 `codex/prototype-cleaning-ui` 分支，**不合入正式扩展**；正式实现用 React 重写。

### 6.1 布局与交互

- **A 单栏连续阅读**：独立扩展全页按文章原顺序连续展开全部**内容块**。文章来源与标题位于正文之前；内容标题保留层级。块序号、初始**块类型**、**保留 / 剔除**、已修改、内容为空等状态都有**文字**表达。
- **编辑**：默认显示阅读预览；点一个块的「编辑 Markdown」才展开该块源码，完成编辑后回到阅读态。**所有块**都可编辑，初始类型不限制当前内容，编辑不重新切块。编辑自动保存，完成编辑不是唯一保存时机。
- **剔除**：剔除后在**原位置折叠成摘要**，不丢弃**当前内容**。摘要提供恢复保留和展开入口；顶部「剔除」筛选可集中找回。恢复保留仍使用当前内容。
- **还原内容**：在单块编辑区域提供，已修改块也可从阅读态操作。**还原前确认一次**，说明会丢弃当前编辑、恢复**初始内容**，但**不改变取舍**。编辑为空仍是有效状态，空白块不进入**清洗结果**。
- **整体块**：列表、引用、表格整体取舍，内部图片随块呈现，**不额外提供子块开关**；用「整体取舍，编辑 Markdown 可删改内部内容与图片」这类提示说明操作方法。**图片引用**按保留块的当前内容判断，共享**图片资源**不会因某一个**图片块**被剔除而从其他块消失。
- **图片**：正常时显示缩略图（直接用远程 URL）。**富媒体块**的降级信息与**未知内容块**的占位是**可编辑、可取舍的正文**；**转换提示**作为界面辅助信息**单独呈现，不自动混进导出正文**。
- **长文导航**：全文搜索、块序号定位、全部/保留/剔除筛选。**不做历史文章侧栏**（那是本地服务前提下的产物，随架构改换作废）。
- **焦点与位置**：操作后保持阅读位置和编辑焦点，避免过滤、取舍、完成编辑导致无故跳顶；目标消失时给一个可继续操作的合理焦点。顶部保存状态与主要操作保持可见。
- **检查结果**：点击打开汇总预览对话框，可切换阅读预览与 Markdown 源码；**仅包含保留块的当前非空内容**，与正式导出的 Markdown 语义一致。返回清洗继续原有进度。空正文时明确提示没有可导出的正文，并引导恢复保留或编辑内容。

### 6.2 状态管理与必须预留的接缝

**单个 `useReducer` + Context，不引入外部 store。** 会话是一棵不可变状态树；单会话、单页面、载荷实测仅 473 KB（600 块），没有跨组件订阅粒度的压力。

**[ADR-0005](./docs/adr/0005-continuous-rendering-without-virtualization.md) 的接缝约束落在这里，而且是可检查的：**

> 全部块的渲染入口收敛到单一的 `BlockList` 组件边界。**搜索、序号定位与焦点管理必须经由 `BlockList` 暴露的接口，不得绕过它访问 DOM。**

具体化为一条能进 code review 的规则：

> **`BlockList` 以外的任何模块不得出现 `document.querySelector` / `document.getElementById` / 直接的 DOM 节点查找。**

`BlockList` 通过 ref 对外暴露命令式接口，例如 `scrollToBlock(id)` / `focusBlock(id)` / `queryVisible()`。

**这条约束为什么重要。** 真正的风险不在渲染，在耦合。界面契约要求操作后保持阅读位置与键盘焦点；若搜索定位和焦点管理直接操作 DOM 并假设「每个块都在文档里」，将来任何虚拟化都会**同时**打碎渲染、搜索和焦点三件事。这是架构约束，不是可选的整洁度建议。

### 6.3 保存与恢复反馈

- 顶部持续区分**正在保存 / 已保存 / 最新更改未保存**。失败提供重试，内存中的编辑仍可继续使用和导出。**导出成功不能把未保存状态改成已保存。**
- 只有**最新修订**保存成功才显示「已保存」；较旧修订完成时，不能把之后的新编辑误标为已保存。
- 自动恢复保存的文字、编辑与取舍；图片按保存地址重新获取。不可用图片显示占位与重试入口，**不阻断文字编辑、不删除引用**，也不承诺离线图片缓存。

---

## 7. 导出

来源：[#6 的解决结论](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012)、[ADR-0003](./docs/adr/0003-export-to-article-directory.md)。旧 `mvp.md` 的 ZIP 约定整体作废。

### 7.1 落地方式与命名

- 从扩展全页调 `showDirectoryPicker()` 选父目录，直接写入 Markdown 和图片。**不提供 ZIP，不引入 `chrome.downloads`。**
- **每次导出都打开目录选择器。** v1 不保存默认导出目录、不持久化目录句柄，不承诺跨会话免授权。浏览器是否回到上次位置属于选择器自身行为。
- 结构：`<文章文件名>/<文章文件名>.md`，本地图片放在同目录的 `images/` 下。**没有本地图片时不创建 `images/`。**
- 重名时依次找 `<文章文件名> (2)`、`(3)` 等未占用名称。**后缀只用于外层目录**，内部 Markdown 文件仍用原清理后的文件名。**不覆盖、不合并、不删除**以前的结果。
- 文件名清理：保留中文与 emoji；把 `/ \ : * ? " < > |` 和控制字符替换为下划线；清除结尾的点与空格；对 Windows 保留名加前缀下划线；清理后为空时用「未命名文章」。基名最多 60 个可见字素，按完整字素截断以免切断 emoji，同时采用不超过 180 UTF-8 字节的保守限制并对最终组件再校验。**完整原始标题仍保存在 `ArticleSource.title`，文件名清理不反写文章元数据。**

示例：首次 `示例文章/示例文章.md` + `示例文章/images/image-001.webp`；再次导出 `示例文章 (2)/示例文章.md`，目录内相对引用仍是 `images/image-001.webp`。

### 7.2 图片

- **图片集合从「所有保留块的当前内容中的有效图片引用」计算**，覆盖**图片块**及列表、引用等块内部的图片，也覆盖用户新增或改写的链接。**不依赖初始图片清单，也不看图片块的开关。** 删掉最后一个保留引用，图片就不再进入导出；另一保留块仍引用同图时，资源仍需导出。
- 识别与重写使用**与预览一致的 Markdown 解析语义**，覆盖行内和引用式图片；代码块、行内代码里的相似字符串不当成图片。**以合成后的正文处理引用定义**，避免逐块正则替换漏掉跨块引用。
- 命名：按第一次有效引用的顺序 `image-001.<扩展名>`、`image-002.…`，超过三位自然增长。编号只要求确定、有序，**不要求下载失败后连续**。
- 同一完整 URL 只下载保存一份，所有引用指向同一个文件。相对网络地址以来源文章 URL 解析为绝对地址；**保留查询参数**，不擅自归一化微信的尺寸、格式或签名参数。不同 URL 即使内容相同，v1 也不做内容哈希去重。
- **保留下载到的原始字节，不转码**；按**实际媒体格式**选扩展名，不能只凭 URL 后缀或固定 `.jpg`（⚠️ [#4](https://github.com/dulltackle/WeTrim/issues/4#issuecomment-5573941622) 的探针就把 PNG 存成了 `.jpg`，不得沿用）。GIF 动画与 WebP 保留原格式。返回 HTML 错误页、无法判定为受支持图片的数据，**按下载失败处理**，不伪装成成功图片。
- 导出副本把成功本地化的引用改为 `images/…` 相对路径，保留替代文字；**不回写清洗会话的当前内容**。普通文字超链接不触发目标页面下载。

### 7.3 未本地化与失败

- v1 自动下载的范围是**实际已获授权的微信图片域名**。新增或修改链接后，符合该范围的图片同样纳入下载；**不临时申请外站权限**。
- 外站图片、权限缺失、HTTP 403、网络错误或无法下载的有效链接，统一列为**未本地化**，显示所在内容、地址及可理解的原因，并提供定位到正文引用的入口。
- **默认暂停导出**，允许重试或返回编辑。只有用户**明确选择**「保留外链继续导出」才保留原网络链接并继续写入其他内容。**不静默丢图，不把部分离线结果报为完整成功。** 对无可用外链的无效地址，说明需要返回编辑修正——勾选绕不过去。
- 写入前让用户完成未本地化图片的选择；写入后反馈是否包含外链及数量。**用户取消目录选择不是错误。**
- 磁盘或权限导致写入失败时，明确报告未完成及可能残留的本次目录，**不报成功，不改动先前产物**；下一次按相同重名规则创建新目录。
- **从一次固定的当前内容生成本次产物**，避免异步下载期间的编辑让 Markdown 与图片集合不一致。

⚠️ **进度反馈不能按张数估。** [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 实测：网络成本由格式与单张体积驱动，与数量无关——6 张全 PNG 的深度长文合计 **9.50 MB**（单张中位 1,623 KB），而 22 张混合格式的图集只有 3.90 MB。图片最少的一篇反而是最贵的那篇的 2.4 倍。

### 7.4 Markdown 与来源信息

- UTF-8，文件顶部 YAML front-matter，固定四字段 `title` / `account` / `date` / `source`（原始标题、公众号名称、发布日期、原文 URL）。**未知值省略，不输出空占位**，不自动添加 tags、作者或抓取时间。
- `date` 是**文章发布日期**，`YYYY-MM-DD`，按 [#2](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738) 的 **UTC+8 硬编码**规则换算，**不随导出设备时区跨日**。无法可靠解析则省略。YAML 字符串正确转义（引号、冒号、换行）。
- 按原顺序输出保留块的当前内容；空字符串或纯空白块不输出，剔除块不留标记。块边界用**一个空行**连接，块内部的换行、缩进、硬换行与代码原样保留——**不能用全篇 `trim` 之类的操作破坏内容语义**。front-matter 与正文间也留一个空行，文件以换行结束。
- 清洗结果没有非空正文时提示「没有可导出的正文」，**不创建只含来源信息的文件**。标题已在来源字段里，**不额外自动插入正文一级标题**；用户保留的标题块照常输出。
- 方言：常见 GFM（列表、任务列表、围栏代码块、简单表格），普通行内格式与链接沿用 Markdown。公式用行内 `$…$` 与独立 `$$…$$`（阅读器是否渲染取决于其支持程度）。
- **表格降级**：能按普通行列表示的输出 GFM 管道表格；存在无法可靠表达的合并单元格或复杂嵌套时，按行、单元格顺序降级为可读文本，保留可取得的文字、链接与图片引用，并显示降级提示。**不以原始 HTML 作为保真兜底。**
- **富媒体占位**：保留名称、说明及有效链接；无法表达的用可读占位如 `【视频】名称`、`【小程序】名称`、`【未知内容】可读说明`，有链接时用 Markdown 链接表达。没有名称或地址就说明原内容的类别，**不伪造信息**。

---

## 8. 持久化

来源：[#7 的解决结论](https://github.com/dulltackle/WeTrim/issues/7#issuecomment-5582245317)、[ADR-0002](./docs/adr/0002-restore-snapshot-block-identity.md)、[ADR-0004](./docs/adr/0004-restore-session-without-image-cache.md)。

### 8.1 storage key 契约

`chrome.storage.local`，**三个固定 key，不按文章建索引，不建历史库**：

| key | 存什么 | 类型 | 生命周期 |
| --- | --- | --- | --- |
| `currentSession` | 当前**清洗会话** | `Session` | 长期，直到用户明确清除或确认替换 |
| `candidateSnapshot` | **候选快照** | `CandidateRecord` | 用户拍板之前；扩展全页关闭即丢弃 |
| `pendingCapture` | 还没解析的抓取结果 | `PendingCapture` | 扩展全页读到后**立即删除** |

**会话按单个 key 整篇序列化，不分块。** [#11](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026) 实测 300 块整篇序列化 2.9 ms、写入 2.7 ms，600 块合计不到 10 ms；分块存储的收益不存在，代价是把单会话 key 与修订号校验复杂化。

声明 `unlimitedStorage` 解除 10 MiB 默认配额。**仍要处理磁盘空间不足、API 拒绝等保存失败**——无限配额不等于保存必成功。（实测载荷：100 / 300 / 600 块分别为 80 KB / 238 KB / 473 KB；真实三篇最大 393 KB。解除配额针对的是未知上界，不是已测规模。）

### 8.2 保存时机与并发

- **文字编辑防抖 500 ms**，且**从第一次未保存的修改起，最长 2 s 内必须发起写入**。这条上限防的是连续输入把防抖无限推迟——只有防抖没有上限时，打字快的人可以数分钟不触发保存，崩溃即全丢。最坏丢失 2 s 输入，代价是每 2 s 一次数毫秒的写入。
- **保留/剔除立即提交；明确的还原操作同样立即提交。** 不走防抖。
- 立即提交**不代表**同步落盘。界面区分「保存中 / 已保存 / 未保存或保存失败」。
- **写入串行化 + 修订号校验**：内存中 `revision` 单调递增；写入走单一队列；发起写入时记下当时的 `revision`，写成功后只有它仍等于当前 `revision` 才显示「已保存」。清除或替换后，旧会话的迟到写入**不得复活或覆盖**它。
- **性能优化不得以拉长保存间隔换取流畅度。**
- **不依赖关闭页面时的异步补存。** 隐藏页面时可尽早提交待保存内容，但强退、崩溃或关闭时尚未保存成功的末尾输入可能丢失。**恢复边界是最后成功保存的记录，不承诺断电零丢失。**

### 8.3 保存失败

保留内存中的编辑和上次成功保存的记录，明确提示未保存并提供重试。**不自动删除原始内容、剔除块或其他数据来降级。** 允许从当前内存内容导出（导出仍遵循 §7 的全部规则）；**导出成功不代表会话保存成功**。

### 8.4 恢复

- 重开扩展全页**直接恢复**上次成功保存的内容与取舍，**不再询问**；没有会话则进入空状态。
- 恢复**不重新抓取、不重新切块、不重新转换、不重新分配块身份**——直接加载保存的记录。
- **不恢复**光标、撤销历史、未完成的导出任务。导出目录句柄不持久化。
- **图片按保存地址重新获取**，不保证断网或源图片失效后仍可见。失败显示占位与重试入口，不阻断文字编辑、不清除引用。当前打开期间可用临时图片缓存，**但它不构成跨关闭恢复的承诺**。

### 8.5 会话生命周期

- **导出成功后保留会话**，可继续编辑和再次导出。只有用户明确清除或确认替换才移除旧进度；清除失败时不能假报已清空。
- 已有会话时从文章页再次点图标：先呈现已有会话，提供「继续当前清洗」和「用刚打开的文章替换」。选择继续不改变旧内容；替换前明确提示旧进度将被清除。
- **新快照获取、解析并成功保存后才完成替换。** 取消、抓取失败、解析失败、保存失败都保留旧会话。**不采用「先清空再抓取」。**

### 8.6 损坏记录与版本兼容

- 可可靠识别和转换的旧格式**自动升级**，保留内容、取舍与块身份，**不以重新抓取或重新转换代替格式升级**。升级成功写入前保留原记录，失败不覆盖原数据。
- 遇到损坏记录或无法识别的格式：**保留原记录**，提示「暂时无法恢复上次进度」，**不静默清空**，也不把它当作没有会话而自动写入新文章。
- 提供三个出口：**下载原始备份**（可读取到的原始记录的文件副本，仅供排查，v1 无导入功能）、**清除并重新开始**（必须明确确认）、**暂不处理**（保留数据，可退出等待修复）。
- **底层存储暂时读失败不等于数据损坏**：先提供重试，不捏造能够备份尚未读取的数据。

---

## 9. 长文性能契约

来源：[#11 的解决结论](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026)、[#12 的修正](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069)、[ADR-0005](./docs/adr/0005-continuous-rendering-without-virtualization.md)、[`docs/research/long-form-performance.md`](./docs/research/long-form-performance.md)。

### 9.1 规模与设备基线

v1 按**微信公众号平台上界量级**设计：约 2 万字、**约 600 块**、数十张图。

> ⚠️ 「约 600 块」是 [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 对 #11 原文「约 300 块」的**修正**。合成样例按每块约 62 字构造，而真实的文字密集长文实测 **35 字/块**（11,986 字 / 347 块），2 万字上界因此对应约 580 块。目标与阈值都不用改（580 落在已实测的 600 块档内），但 1000 块阈值相对平台上界的余量从约 3.3 倍缩到约 1.7 倍。
>
> ⚠️ 「2 万字上界」本身来自中文运营站与英文营销资料，**二手且互相冲突，未经微信官方文档确认**。方案写成「按此量级设计，实测后修订」，**不得写成「保证支持 2 万字」**。

**验收基准：Chrome 稳定版 + DevTools CPU 4× 降速**，作为低端设备的可复现代理。全部目标数值定在降速档，不用开发机裸测值。

4× CPU 降速**不模拟慢磁盘、低内存、弱网**。这三项不新增独立的降级行为，沿用既有契约：弱网 → 图片占位与重试；慢磁盘 → 保存三态；低内存导致标签页崩溃 → 恢复边界是最后一次成功保存。

### 9.2 性能目标

全部为 4× 降速档。括号内是 [#11](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026) 探针在 300 块 / 1.87 万字 / 30 图上的实测值。

| 项目 | 目标 | 探针实测 |
| --- | --- | --- |
| 载入到可交互 | ≤ 1.5 s | 670 ms |
| 单块取舍反馈 | ≤ 100 ms | 低于一帧 |
| 逐字编辑反馈 | ≤ 50 ms | 低于一帧 |
| 开/关单块编辑器 | ≤ 100 ms | 低于一帧 |
| 检查结果预览生成 | ≤ 300 ms | 19.4 ms |
| 搜索/筛选响应 | ≤ 100 ms | ⚠️ **未测** |
| 自动保存（序列化 + 写入） | ≤ 200 ms，且不阻塞输入 | 5.6 ms ⚠️ **代理值** |
| 图片呈现 | 无时间目标；不阻塞文字编辑，失败有占位与重试 | — |

逐字编辑的目标比取舍严一档，因为输入必须跟手，两者的可接受延迟差一个数量级。图片呈现只给行为目标，因为耗时由用户网络与微信 CDN 决定，定时间目标等于承诺我们控制不了的事。

**这些目标同时是回归保护**：现在轻松达标，正因如此才要写下来，否则将来某次改动把它们弄慢了没人会发现。

### 9.3 超出能力时的提示

- 触发口径为**块数**，阈值 **≥ 1000 块**，在抓取解析完成、**开始渲染之前**判定。提示先于等待发生才有价值。
- **图片数量不进入阈值。** 实测内存由图片解码主导但随规模饱和（30 图 +202 MB，60 图 +223 MB，Chrome 会丢弃离屏解码）；真正受图片数影响的是滚动时的重解码频率，而该项在 60 张图时 p95 仍为 34 ms。
- **平台上界量级的文章约 600 块，正常情况下这条提示永远不会触发**——它是安全网，不是活跃功能。实现时不要把它当常态特性设计。三篇真实样例最大 347 块，未触发。
- 阈值是可调常量，**只触发提示，不拒绝清洗**。

### 9.4 契约形态

**不设数量或大小的硬上限，任何长度的文章都不拒绝清洗。** 契约 = 可测目标 + 超出能力时的诚实提示 + 资源或保存失败时的降级行为（失败保留内存进度，允许重试或直接导出）。拒绝服务需要一个今天没有证据支撑的阈值，只会在真实长文上误伤。

### 9.5 渲染策略

**连续渲染全部内容块，不做虚拟列表，也不做分段延迟呈现。** 实测：300 块挂载 670 ms、600 块 850 ms；滚完全篇每步 p95 34 ms，600 块 / 60 图页面高 126,879 px 时最差 39.2 ms，未观察到掉帧。相对平台上界仍有数倍余量，虚拟化没有可证明的收益。

默认关闭的分段呈现开关**同样不做**——那是在无证据的情况下先付复杂度，而且不走的代码路径必然腐烂。

必须预留的接缝见 §6.2。

---

## 10. 验收样例

十篇真实文章，按用途分三组。实现期的验证直接用这些 URL，不必再「按标准去找」。

**端到端可行性**（[#4](https://github.com/dulltackle/WeTrim/issues/4#issuecomment-5573941622)，完整快照与逐元素比对记录在票中）

- <https://mp.weixin.qq.com/s/4oW2sWIYTpoTc58FhQWWhQ>
- <https://mp.weixin.qq.com/s/q8otur4qi_-6Gc13vBE7ZQ>
- <https://mp.weixin.qq.com/s/pKl5Ku7C50eUnBUAmPNf5A>

三篇均含正文内的 `mp-common-profile` 公众号卡片；文字结构与真实图片 URL 顺序在滚动前后完全一致。

**长文性能**（[#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069)，样例 JSON 归档在 `probe/long-form-samples` 分支）

| 维度 | 文章 | 字数 | 块数 | 正文 HTML | DOM 元素 | 图片 |
| --- | --- | --- | --- | --- | --- | --- |
| 深度长文 | [每10年换一副骨架…](https://mp.weixin.qq.com/s/bFIyu9ssse5vOqi6sEHVYw) | 11,986 | **347** | **295.7 KB** | **5,569** | 6（全 PNG，**9.50 MB**） |
| 图集 | [神经根型颈椎病的诊疗思路与治疗](https://mp.weixin.qq.com/s/8EIed5cmXFIB2uqxDg3CYg) | 1,283 | 67 | 122.9 KB | 323 | **22**（3.90 MB） |
| 复合结构 | [Advanced Science｜骨修复材料的下一步](https://mp.weixin.qq.com/s/l-CVnH-C0hO4nTQX1MNa4g) | 3,625 | 64 | 81.2 KB | 565 | 10（3.16 MB） |

块类型分布：深度长文 段落 322 / 表格 19 / 图片 6；图集 段落 43 / 图片 22 / 富媒体 1 / 列表 1；复合结构 段落 46 / 图片 10 / 标题 6 / 表格 2。

**结构覆盖**（[#13](https://github.com/dulltackle/WeTrim/issues/13#issuecomment-5631234452)，样例 JSON 归档在 `probe/structure-samples` 分支）

| 标签 | 文章 | 贡献的结构 |
| --- | --- | --- |
| `code` | [从光学鼠标到企业 AI…](https://mp.weixin.qq.com/s/SR9YbSi_VXFwtC4Cf-hsMw) | 第三方 `pre > code` 代码块 |
| `list` | [Agent 长程任务断点续传…](https://mp.weixin.qq.com/s/Vy2HpOyr7wVmPTVWa3mGig) | 3 个有序列表、7 个官方代码块、44 处行内代码 |
| `quote-list` | [48小时数百万浏览：Graph Engineering…](https://mp.weixin.qq.com/s/-y9Gqkckr1AJsuNReEKZYg) | 引用、无序列表 |
| `rich-misc` | [AI 开始批准代码合并了](https://mp.weixin.qq.com/s/nFgdzgL9kWXdYAfmu7gvPQ) | 富媒体卡片、行内代码 |

四篇里**所有结构的切块行为全部符合 ADR-0001**。

---

## 11. 解析验证范围

[#8](https://github.com/dulltackle/WeTrim/issues/8) 第 9 条要求：明确后续实现的验证要求，**不能把已有端到端探针的通过当作这些转换规则已验证**。

**可用真实样例验证**：代码块两种形态、有序/无序列表（**仅一级**）、单段落引用、富媒体卡片（公众号名片 + 小程序卡片）、行内代码、表格（[#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 的 19 + 2 个，215 个 `td`）。

**只能用构造 HTML 验证**（无真实样本）：嵌套列表（**两种编码假设都要覆盖**）、引用套列表、多段落引用、公式（行内与独立）、空 `js_darkmode` `<pre>` 噪声。

**实现期的必测用例清单**（跨导出、持久化、入口三块，来自各票的验收要求）：

- **转换与切块**：嵌套列表与引用、段落图文混排（文字 → 图片 → 文字拆三块）、共享图片跨块引用、空编辑与还原、复杂表格降级、行内与独立公式、属性承载内容的公众号名片、未知节点、从 Word 粘贴的命名空间标签（`<o:p>`）。
- **导出**：重名目录及同名文件、Windows 保留名与长 emoji 标题、空正文、同图跨块复用与最后一个引用删除、编辑后新增链接、引用式图片与代码中的伪图片、WebP/GIF 与非图片响应、403 / 缺权限 / 外站图片的重试与明确继续、写入中途失败、YAML 特殊字符、复杂表格与公式的预览导出一致性。
- **持久化**：防抖中关闭与恢复、迟到写入、保存失败后重试与内存导出、新文章获取或保存失败时旧进度保留、同文重抓、导出后保留会话、清除后迟到写入、重复标签与 worker 重启、图片失效、兼容升级失败、未知格式与损坏记录的备份/取消/明确清除。
- **入口与页面状态**（[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 的 12 条）：正常文章页无旧会话不弹确认；有旧会话弹确认且选「继续」后旧内容一字未变、候选被清除；微信提示页显示的原因文字与 `.weui-msg__title` 完全一致；`chrome://` 页面点图标仍打开/聚焦扩展页并给非模态提示；验证页走通用提示且不代为验证；候选落盘后关闭原文标签仍可替换；同 URL 连点不重抓；先 A 后 B 候选变 B 而当前会话不变；候选未处理就关页则重开恢复旧会话；候选写盘失败不弹确认且保留旧会话；注入成功但切块失败给通用提示且未写候选；正文仍在增长时的探测等待与超时提示。

---

## 12. 实现期必须验证：现在不得当作已验证

这一节是本方案的**诚实边界**。以下每一条在今天都**没有**实现层面的证据。任何后续文档、提交说明或票据都不得把它们记为已验证。

| 条目 | 现状 | 出处 |
| --- | --- | --- |
| 搜索 / 筛选响应 ≤ 100 ms | 探针未实现该功能，目标按感知阈值设定，**从未测过** | #11 |
| `chrome.storage.local` 真实写入耗时 | 表中 5.6 ms 是同样由 LevelDB 支撑的 **IndexedDB 代理值**，缺少扩展页到浏览器进程的一次 IPC（Chrome 153 已移除 `--load-extension`，CDP 安装后扩展页仍 `ERR_BLOCKED_BY_CLIENT`） | #11 |
| Turndown 转换 347 块的耗时 | **完全没测过**。深度长文每块约 16 个元素（5,569 元素 / 347 块，其中 4,234 个 `span`），比合成样例杂乱得多。裸 Node 上解析 295.7 KB 用 13.4 ms、切块 8.3 ms，4× 降速下**估计**百毫秒级——**这是估算不是实测** | #12 |
| 单块交互的真实耗时 | 取舍、开关编辑器、逐字输入在所有规模与两个降速档下测得的值全部等于双帧等待的量化地板，只能得出「低于一帧」 | #11 |
| 「内存随图片数饱和」 | 只有 30 / 60 张**合成图**的证据。真实图片解码尺寸已证明与合成同量级（中位 1080×812 / 1080×537 / 945×1265），但饱和结论本身**未在真实数据上验证**。若实现期在真实长文上观察到内存异常，这里是第一个要回头查的地方 | #11 / #12 |
| 微信图片是否真需要 `Referer` | #4 的 SW 未主动注入 Referer 也成功，但探针**未捕获实际请求头**，精确说法是「未主动注入」，不是「抓包证实不存在」。若实测确认需要，用 `declarativeNetRequest` 的 `modifyHeaders` 补，权限 `declarativeNetRequestWithHostAccess`（不扩大警告面） | #3 / #4 |
| `mmbiz.qlogo.cn` 是否真的用得上 | 未确认。**能少一个域名就少一点警告面** | #3 |
| `list-paddingleft-N` 的嵌套编码方式 | 四篇真实样例 12 个内容列表**全部是 `-1`**，`<li>` 内直接含列表的数量为 **0**。这是**否定证据**，既可能说明微信用平铺编码，也可能只说明这四篇恰好没有多级列表——**两者无法从现有样本区分**。实现期必须确认，两种假设都要能跑 | #13 |
| 嵌套列表 / 引用套列表 / 多段落引用 / 公式 / 空 `pre` 噪声 | **无真实样本**，结论全部来自手工构造的 HTML | #13 |
| 内容稳定探测的 300 ms / 2 s 阈值 | **未实测**，是依据「`data-src` 预写、无需滚动」所做的设计，需在真实文章上校准 | #10 |
| 微信提示页的文案种类 | **只观察到「参数错误」一种**。「该内容已被发布者删除」等落在同一模板里是基于模板一致性的**推断**，无真实样本——这正是判定只看文案是否非空、口径只做转述的原因 | #10 |
| React / Turndown / GFM 插件 / marked / DOMPurify 的生产构建是否依赖 `eval` | **未实测**。CSP 违规在扩展里是静默失败，极难排查 | #3 |
| 商店安装时的实际权限提示 | #4 观察的是「加载已解压扩展」，**不能推广为商店安装** | #3 / #4 |
| 跨会话免授权 / 目录句柄持久化 | 开发者观察到选择器记住上次位置，但这**不等于**句柄持久化或免授权。v1 本就不持久化句柄 | #4 / #6 |

---

## 13. 不做什么

搬自地图的 Out of scope，让接手的人不必猜。以下每一条都是**已判定在 v1 终点之外**，不会因为「顺手」而回到范围内。

- **本地文章库 / 历史管理**：持久化只覆盖「当前这一篇」，多篇管理是另一个产品方向。
- **批量抓取与排队处理**：本工具的前提就是一篇一篇手动清洗。
- **粘贴 URL 加载文章**：见 [ADR-0006](./docs/adr/0006-single-entry-from-article-tab.md)。这是真正的取舍，不是暂缓实现——事后补要改权限、改警告面并重新过审。
- **Firefox 支持**：MV3 差异与单独上架的成本，对非目标用户群不划算。
- **Python CLI / Camoufox / 本地 Node 服务**：随架构改换整体作废。
- **块的拖拽排序**：原 `mvp.md` 即已排除，继续排除。
- **Electron / Tauri 桌面应用路线**：已在地图 charting 阶段比较后否决。
- **ZIP 导出**：随 [#6](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012) 作废，JSZip 不引入。
- **离线图片缓存**：[ADR-0004](./docs/adr/0004-restore-session-without-image-cache.md) 明确不持久化图片文件。恢复时重新获取，失败给占位和重试。
- **虚拟列表 / 分段延迟呈现**：[ADR-0005](./docs/adr/0005-continuous-rendering-without-virtualization.md)。接缝要留，实现不做。
- **备份导入**：v1 只提供「下载原始备份」用于排查，没有导入恢复功能。
