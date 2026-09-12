# WeTrim 架构与实现契约

## 0. 这份文档是什么

WeTrim v1 的**实现层**契约：架构分层、执行上下文边界、数据流、数据结构、消息协议、存储契约、源码结构，以及实现期的验证清单。

产品事实——用户、定位、能力与约束、权限清单、性能目标、证据与「不得当作已验证」的清单——在根目录 [`PRODUCT.md`](./PRODUCT.md)，本文件不重复。领域术语以 [`CONTEXT.md`](./CONTEXT.md) 为准，切块规则见 [`docs/conversion-rules.md`](./docs/conversion-rules.md)，决策论证见 [`docs/adr/`](./docs/adr/) 与 [`docs/research/`](./docs/research/)。

本文件区分**已决定**、**已实测**、**尚未验证**三件事，并且从不混用；⚠️ 标记的地方是就地的诚实边界，完整清单在 `PRODUCT.md`。

---


## 1. 三个执行上下文与职责

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

---

## 2. 数据流总览

```
用户在文章页点扩展图标
  │
  ▼
service worker: action.onClicked
  │  chrome.scripting.executeScript(注入 content script)
  ▼
content script: 判定 → 稳定探测 → 取 outerHTML + 元数据
  │  返回 CaptureResult（见 §4.3）
  ▼
service worker: 把 CaptureResult 写进 storage 的 pendingCapture
  │  打开或聚焦扩展全页；若已打开，发一条不带数据的叫醒消息
  ▼
扩展全页: 读 pendingCapture → 立即删除该 key
  │
  ├─ kind !== 'article' ──▶ 按 §4.1 的三档口径提示，不动 currentSession
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

---

## 3. manifest 与源码目录结构

### 3.1 manifest

权限的理由与安装警告见 `PRODUCT.md` 的「权限与上架」；这里是 manifest 原文。

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

### 3.2 源码目录结构

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
│   │   ├── BlockList.tsx         # 全部块的唯一渲染入口（见 §7）
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

## 4. 主流程实现

### 4.1 入口与页面判定

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

- **判定逻辑不得匹配具体文案**，只判断 `.weui-msg__title` 是否存在且非空。⚠️ 原因见 `PRODUCT.md` 的「现在不得当作已验证」：真实观察到的提示文案**只有「参数错误」一种**，其余文案落在同一模板里是基于模板一致性的推断，无样本。
- **验证页**（URL 路径 `/mp/wappoc_appmsgcaptcha`）是第 3 档里唯一单独给路径的子情况：提示用户回到原文页面自行完成验证，完成后再点图标。**不代替用户完成验证。**

读不了的页面照常打开/聚焦扩展全页并给非模态提示，以及空状态的三步说明，属于产品行为，见 `PRODUCT.md` 的运行场景小节。**不弹替换确认框**，因为没有**候选快照**可替换。

### 4.2 内容稳定探测

- 点击后**立即读一次 DOM**。`#js_content` 不存在即按三档判定处理。
- `#js_content` 存在时做一次稳定性探测：正文文本长度与 `img[data-src]` 数量在约 **300 ms** 内不再增长即认为稳定，**最多等约 2 秒**。
- 超时则按当前拿到的内容继续，并在扩展全页顶部提示「文章可能还没显示完整，可以回到原文等它加载完再重新抓一次」。**不假装抓全了**（`CaptureResult.unstable = true` 承载这个信号）。
- 不采用上游的固定 2 秒 sleep：[#2](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738) 已查明微信把图片真实地址预写进 `data-src`、**不需要模拟滚动**，且用户通常是看着页面显示完才点图标。

⚠️ **300 ms / 2 秒这两个阈值尚未实测**，是依据「真实地址预写进 `data-src`」所做的设计，实现期需在真实文章上校准。

### 4.3 抓取载荷与传递

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

### 4.4 解析、切块与转换

在扩展全页里：

1. `new DOMParser().parseFromString(contentHtml, 'text/html')` 重建 DOM；
2. 按 [ADR-0001](./docs/adr/0001-content-block-boundaries.md) 与 [#5](https://github.com/dulltackle/WeTrim/issues/5#issuecomment-5581555371) 的规则切出**内容块**；
3. 每块**独立**转换成 Markdown（见 §6 与 [ADR-0007](./docs/adr/0007-per-block-conversion.md)）；
4. 组装 `ArticleSnapshot`。

### 4.5 候选快照与替换确认

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

### 4.6 单实例保证

[#7](https://github.com/dulltackle/WeTrim/issues/7#issuecomment-5582245317) 要求：只允许一个有效编辑页；手动复制标签、连续点击或浏览器恢复出多个页面时也必须成立；**不能仅靠 service worker 内存里的 tabId 作为跨重启保证**。

做法：

- service worker 打开扩展全页前，用 `chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')] })` 查是否已有同类页面——这查的是**浏览器实时状态**，不是 service worker 内存，因此跨 worker 重启有效。已有就 `chrome.tabs.update({ active: true })` 聚焦，不新开。
- 扩展全页**自己也要查一次**：启动时同样调用 `getContexts`，若发现不止一个同类页面（用户手动复制标签、浏览器会话恢复），则按确定规则选一个为写入方（例如 `documentId` 最小者），其余进入只读态并提供「切换到正在编辑的页面」。
- 只读态的页面不写 storage，也不显示保存状态。

---

## 5. 块模型与数据结构

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

本地文件名、缩略图、下载结果都是**派生信息**，不进 `ImageAsset`，也不能充当块身份。导出时的本地文件名属于导出映射，规则见 [`PRODUCT.md`](./PRODUCT.md) 的导出小节。

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

## 6. HTML → Markdown 转换

逐条规则清单在 [`docs/conversion-rules.md`](./docs/conversion-rules.md)。本节只定架构与失败处理。

### 6.1 基座与一条硬约束

Turndown 作为基座，`turndown-plugin-gfm` 提供表格，再加一组微信专用 rule。Turndown 真正提供的价值是行内格式、链接、Markdown 特殊字符转义，以及「未知标签去标签留内容」这个默认行为——后者正好等价于 [#2](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738) 里 markdownify 对微信那堆嵌套 `<section>` / `<span style>` 达成的效果，因此**不需要写任何「拍平嵌套 section」的代码**。

**硬约束：每个内容块独立转换，绝不「整篇拼接后再回填占位符」。** 见 [ADR-0007](./docs/adr/0007-per-block-conversion.md)。上游正是栽在这里——占位符 `CODEBLOCK-PLACEHOLDER-1` 是 `-10`…`-19` 的前缀，顺序 `str.replace()` 会把它们吃掉，一篇 40 个代码块的文章只有前 10 个存活。按块转换让整个 bug 类别不存在，但**前提是不要重新引入占位符方案**。

### 6.2 转换失败的两档处理

[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 定了「注入成功但切块失败 → 通用提示 + 重试，不写候选」，但没区分整篇与单块。这里补齐：

| 档 | 触发条件 | 行为 |
| --- | --- | --- |
| **整篇级** | 拿不到 `#js_content`；HTML 文本解析不出 DOM；切块器整体抛错 | 按 §4.1 第 3 档走通用提示 + 重试。**不写 `candidateSnapshot`，不动 `currentSession`** |
| **单块级** | 某块转换抛错；或**原始 HTML 非空却转出空内容** | 该块降级为**未知内容块**：`type = 'unknown'`，`initialMarkdown` 写可读占位说明，挂一条 `code: 'convert-failed'` 的**转换提示**。**候选照常写入** |

**为什么必须分两档。** [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 那篇深度长文有 347 个块。若任何转换异常都算整篇失败，一个没见过的结构就让整篇清洗不了，而用户看到的还是「这个页面上没找到公众号文章正文」加一个重试按钮——重试还是同一篇、同一个结构，永远失败。用户没有出路，提示还是错的。

**第二条触发条件（非空 HTML 转出空）不是凑数的。** [#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 记录过一个真实案例：切块器把公众号名片整个丢掉了——那张卡片没有文本节点、没有 `img` 子节点，全部内容在属性里，用「无块级后代 = 叶子」当穿透判据就会让它静默消失。**不抛错，但内容没了**，这比抛错危险，因为没人会发现。所以要主动检查。

这跟已定的姿态一致：[#5](https://github.com/dulltackle/WeTrim/issues/5#issuecomment-5581555371) 要求「不以空字符串静默丢失」，[#6](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012) 要求「不伪造信息，也不使用空字符串掩盖内容丢失」。

### 6.3 预览与导出共用一套方言

预览与导出使用**同一套** Markdown 方言、**当前内容**、保留状态、表格降级和富媒体占位规则。预览展示安全渲染（marked + DOMPurify）后的结果并提示降级，导出保留相应 Markdown 源码。**唯一差异是图片 URL 到本地路径的映射**，那是导出副本才有的。

预览不承诺与每一种外部 Markdown 阅读器像素一致。

---

## 7. 状态管理与必须预留的接缝

**单个 `useReducer` + Context，不引入外部 store。** 会话是一棵不可变状态树；单会话、单页面、载荷实测仅 473 KB（600 块），没有跨组件订阅粒度的压力。

**[ADR-0005](./docs/adr/0005-continuous-rendering-without-virtualization.md) 的接缝约束落在这里，而且是可检查的：**

> 全部块的渲染入口收敛到单一的 `BlockList` 组件边界。**搜索、序号定位与焦点管理必须经由 `BlockList` 暴露的接口，不得绕过它访问 DOM。**

具体化为一条能进 code review 的规则：

> **`BlockList` 以外的任何模块不得出现 `document.querySelector` / `document.getElementById` / 直接的 DOM 节点查找。**

`BlockList` 通过 ref 对外暴露命令式接口，例如 `scrollToBlock(id)` / `focusBlock(id)` / `queryVisible()`。

**这条约束为什么重要。** 真正的风险不在渲染，在耦合。界面契约要求操作后保持阅读位置与键盘焦点；若搜索定位和焦点管理直接操作 DOM 并假设「每个块都在文档里」，将来任何虚拟化都会**同时**打碎渲染、搜索和焦点三件事。这是架构约束，不是可选的整洁度建议。

### 7.1 保存与恢复反馈

- 顶部持续区分**正在保存 / 已保存 / 最新更改未保存**。失败提供重试，内存中的编辑仍可继续使用和导出。**导出成功不能把未保存状态改成已保存。**
- 只有**最新修订**保存成功才显示「已保存」；较旧修订完成时，不能把之后的新编辑误标为已保存。
- 自动恢复保存的文字、编辑与取舍；图片按保存地址重新获取。不可用图片显示占位与重试入口，**不阻断文字编辑、不删除引用**，也不承诺离线图片缓存。

---

## 8. 持久化实现

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

保留内存中的编辑和上次成功保存的记录，明确提示未保存并提供重试。**不自动删除原始内容、剔除块或其他数据来降级。** 允许从当前内存内容导出（导出仍遵循 `PRODUCT.md` 的全部导出规则）；**导出成功不代表会话保存成功**。

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

## 9. 解析验证范围与实现期必测清单

[#8](https://github.com/dulltackle/WeTrim/issues/8) 第 9 条要求：明确后续实现的验证要求，**不能把已有端到端探针的通过当作这些转换规则已验证**。

**可用真实样例验证**：代码块两种形态、有序/无序列表（**仅一级**）、单段落引用、富媒体卡片（公众号名片 + 小程序卡片）、行内代码、表格（[#12](https://github.com/dulltackle/WeTrim/issues/12#issuecomment-5602467069) 的 19 + 2 个，215 个 `td`）。

**只能用构造 HTML 验证**（无真实样本）：嵌套列表（**两种编码假设都要覆盖**）、引用套列表、多段落引用、公式（行内与独立）、空 `js_darkmode` `<pre>` 噪声。

**实现期的必测用例清单**（跨导出、持久化、入口三块，来自各票的验收要求）：

- **转换与切块**：嵌套列表与引用、段落图文混排（文字 → 图片 → 文字拆三块）、共享图片跨块引用、空编辑与还原、复杂表格降级、行内与独立公式、属性承载内容的公众号名片、未知节点、从 Word 粘贴的命名空间标签（`<o:p>`）。
- **导出**：重名目录及同名文件、Windows 保留名与长 emoji 标题、空正文、同图跨块复用与最后一个引用删除、编辑后新增链接、引用式图片与代码中的伪图片、WebP/GIF 与非图片响应、403 / 缺权限 / 外站图片的重试与明确继续、写入中途失败、YAML 特殊字符、复杂表格与公式的预览导出一致性。
- **持久化**：防抖中关闭与恢复、迟到写入、保存失败后重试与内存导出、新文章获取或保存失败时旧进度保留、同文重抓、导出后保留会话、清除后迟到写入、重复标签与 worker 重启、图片失效、兼容升级失败、未知格式与损坏记录的备份/取消/明确清除。
- **入口与页面状态**（[#10](https://github.com/dulltackle/WeTrim/issues/10#issuecomment-5631603811) 的 12 条）：正常文章页无旧会话不弹确认；有旧会话弹确认且选「继续」后旧内容一字未变、候选被清除；微信提示页显示的原因文字与 `.weui-msg__title` 完全一致；`chrome://` 页面点图标仍打开/聚焦扩展页并给非模态提示；验证页走通用提示且不代为验证；候选落盘后关闭原文标签仍可替换；同 URL 连点不重抓；先 A 后 B 候选变 B 而当前会话不变；候选未处理就关页则重开恢复旧会话；候选写盘失败不弹确认且保留旧会话；注入成功但切块失败给通用提示且未写候选；正文仍在增长时的探测等待与超时提示。

---

## 10. 导出实现契约

产品层的承诺（目录结构、重名规则、文件名清理、未本地化默认暂停、front-matter 四字段）在 `PRODUCT.md`；这里是实现时需要的操作规则。

### 10.1 图片引用的识别与重写

- 识别与重写使用**与预览一致的 Markdown 解析语义**，覆盖行内和引用式图片；代码块、行内代码里的相似字符串**不当成图片**。**以合成后的正文处理引用定义**，避免逐块正则替换漏掉跨块引用。
- 命名按第一次有效引用的顺序 `image-001.<扩展名>`、`image-002.…`，超过三位自然增长。编号只要求确定、有序，**不要求下载失败后连续**。
- 相对网络地址以来源文章 URL 解析为绝对地址。不同 URL 即使内容相同，v1 也**不做内容哈希去重**。
- GIF 动画与 WebP 保留原格式。
- 导出副本把成功本地化的引用改为 `images/…` 相对路径并保留替代文字，**不回写清洗会话的当前内容**。普通文字超链接不触发目标页面下载。
- **从一次固定的当前内容生成本次产物**，避免异步下载期间的编辑让 Markdown 与图片集合不一致。

### 10.2 未本地化与写入失败

- 自动下载的范围是**实际已获授权的微信图片域名**。新增或修改链接后，符合该范围的图片同样纳入下载；**不临时申请外站权限**。
- 未本地化清单显示所在内容、地址及可理解的原因，并提供**定位到正文引用的入口**。对无可用外链的无效地址，说明需要返回编辑修正——「保留外链继续」勾选绕不过去。
- 写入前让用户完成未本地化图片的选择；写入后反馈是否包含外链及数量。**用户取消目录选择不是错误。**
- 磁盘或权限导致写入失败时，明确报告未完成及可能残留的本次目录，**不报成功，不改动先前产物**；下一次按相同重名规则创建新目录。
- ⚠️ **进度反馈不能按张数估**：网络成本由格式与单张体积驱动，与数量无关（实测数字见 `PRODUCT.md`）。

### 10.3 Markdown 输出

- 按原顺序输出保留块的当前内容；空字符串或纯空白块不输出，剔除块不留标记。块边界用**一个空行**连接，块内部的换行、缩进、硬换行与代码原样保留——**不能用全篇 `trim` 之类的操作破坏内容语义**。front-matter 与正文间也留一个空行，文件以换行结束。
- YAML 字符串正确转义（引号、冒号、换行）。
- 方言：常见 GFM（列表、任务列表、围栏代码块、简单表格），普通行内格式与链接沿用 Markdown。公式用行内 `$…$` 与独立 `$$…$$`（阅读器是否渲染取决于其支持程度）。
- **表格降级**：能按普通行列表示的输出 GFM 管道表格；存在无法可靠表达的合并单元格或复杂嵌套时，按行、单元格顺序降级为可读文本，保留可取得的文字、链接与图片引用，并显示降级提示。**不以原始 HTML 作为保真兜底。**
- **富媒体占位**：保留名称、说明及有效链接；无法表达的用可读占位如 `【视频】名称`、`【小程序】名称`、`【未知内容】可读说明`，有链接时用 Markdown 链接表达。没有名称或地址就说明原内容的类别，**不伪造信息**。
