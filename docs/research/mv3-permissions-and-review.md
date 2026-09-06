# 调研：MV3 权限模型与 Chrome Web Store 审核约束

对应 issue #3。地图见 issue #1。

**结论先行**：本项目所需的权限组合**几乎不触发任何安装警告**——`activeTab` / `scripting` / `storage` / `unlimitedStorage` 全部无警告，File System Access API 连权限声明都不需要。唯一会产生警告的是抓图片所需的 `host_permissions`。

但调研过程中**推翻了地图讨论阶段的一个假设**，见第 2 节。

---

## 1. 抓正文要什么权限

**`activeTab` + `scripting` 就够，且零警告。**

`activeTab` 在用户做出手势后临时授予「当前标签页主框架源」的主机权限。触发手势包括：点击扩展图标、点击右键菜单项、键盘快捷键、接受 omnibox 建议。本项目的入口正是「在文章页点扩展图标」，完全匹配。

它授予的能力：

- 调用 `scripting.executeScript()` / `scripting.insertCSS()` 注入脚本与样式（**需同时声明 `scripting` 权限**）；
- 读取该标签页的 URL、标题、favicon；
- 用 webRequest 拦截指向该标签页主框架源的请求（本项目用不到）。

有效期：用户停留在该页面期间有效。同域导航（`example.com` → `example.com/foo`）权限保持；切换到不同站点立即撤销。对本项目没有影响——用户点图标之后我们立刻抓完 DOM 快照就走。

**安装警告**：`activeTab` 和 `scripting` **都不显示任何警告**。

> 备选方案是显式声明 `host_permissions: ["*://mp.weixin.qq.com/*"]`。功能上更省事（不依赖用户手势，随时可注入），但会产生「读取和更改你在 mp.weixin.qq.com 上的数据」的安装警告。**本项目不需要**——我们的入口本来就是用户主动点击。

## 2. 抓图片要什么权限 ⚠️ 推翻了先前的假设

**地图讨论阶段我判断「在页面上下文里 fetch 图片天然带对 Referer」。这个判断是错的**，原因不是 Referer，而是那个 fetch 根本发不出去。

**自 Chrome 85 起，content script 的跨域 fetch 被 CORS 禁止**（CORS-for-content-scripts）。content script 发起的请求被视为代表其注入的**网页源**（`mp.weixin.qq.com`），因此受同源策略约束。图片在 `mmbiz.qpic.cn`，属于跨域，而微信图片服务器不会返回 CORS 头，所以从 content script 直接 fetch 图片**必然失败**。

正确做法：

1. **从 service worker（或扩展页）发起 fetch**——扩展上下文的跨域请求在声明了对应 `host_permissions` 后绕过 CORS；
2. `host_permissions` 必须覆盖图片域名：`*://mmbiz.qpic.cn/*`，以及可能用到的 `*://mmbiz.qlogo.cn/*`（公众号头像等）；
3. content script 只负责把图片 URL 列表传给 service worker，由后者去取。

**Referer 防盗链怎么办**：扩展上下文发起的 fetch **默认不带 Referer**。上游调研（#2）确认微信图片需要 `Referer` 头。如果实测确认必须有，方案是用 `declarativeNetRequest` 的 `modifyHeaders` 规则给这些请求加上 Referer，权限用 `declarativeNetRequestWithHostAccess`（它只在已有主机权限的范围内生效，因此不额外增加警告面）。

> **这条必须在 #4 里实测**：先直接 fetch 试试，很多情况下微信图片对无 Referer 的请求是放行的（浏览器直接打开图片 URL 通常能看到图）。只有确认 403 才需要引入 `declarativeNetRequest`。

**安装警告**：`host_permissions` 是唯一会产生警告的一项，文案形如「读取和更改你在 mmbiz.qpic.cn、mmbiz.qlogo.cn 上的数据」。

> **一个真实的产品取舍**：只声明图片域名，警告里出现的是用户完全不认识的 `mmbiz.qpic.cn`，反而可能比出现 `mp.weixin.qq.com` 更让人不安。如果把 `*://mp.weixin.qq.com/*` 也加进 `host_permissions`（放弃 `activeTab` 的零警告），文案会变成「…mmbiz.qpic.cn、mmbiz.qlogo.cn 和 mp.weixin.qq.com…」，多一个可辨识的域名，观感也许更好。这个取舍留到上架阶段定，功能上两种都可行。

## 3. 写文件要什么权限

| 方案 | 权限声明 | 安装警告 |
|---|---|---|
| File System Access API（`showSaveFilePicker` / `showDirectoryPicker`） | **不需要任何声明** | **无** |
| `chrome.downloads` | `"downloads"` | **「管理您的下载内容」** |

用户通过系统文件选择器选择目标，这本身就构成授权，所以 File System Access API 不需要 manifest 权限。

**这给 #6 的「直写目录 vs zip 下载」增加了一个新论据**：File System Access 不仅体验更好，权限提示也更干净。前提是 #4 验证它在扩展全页里确实可用（已知 Chromium bug [40240444](https://issues.chromium.org/issues/40240444) 在 popup 里会失败）。

## 4. 审核约束

**宽泛 host permissions 会显著拖长审核**——官方明确写了：「请求宽泛主机权限或敏感执行权限的扩展，或包含大量代码的扩展可能需要更长审核时间。」典型的危险模式是 `*://*/*`。

**本项目风险低**：我们只声明两三个具体域名，不是通配全站；并且核心的正文读取走 `activeTab`（用户手势授权，是官方推荐的最小权限模式）。

审核时长：多数几天，可能几周。超过三周可联系开发者支持。会拖长的信号：新开发者 / 新扩展、危险权限、代码变动大——我们至少会命中「新开发者 + 新扩展」，所以**首次提交要预留时间，别卡着 deadline**。

**必须提交的材料**：

- **隐私政策 URL**——处理用户数据的产品必须在开发者控制台发布隐私政策。本扩展会读取网页内容并写入本地文件，需要说明「数据不离开用户设备」。
- **数据收集披露 + 有限使用认证**——控制台「隐私实践」部分的表格，**每个项目都必须填写才能发布或更新**。⚠️ 未在 30 天内完成披露的项目**会被暂停并下架**。
- **权限用途说明**——官方的建议做法是在商店描述或扩展内「关于」页里逐条列出所用权限及理由。

常见拒审原因：违反开发者政策、**代码混淆（禁止）**、权限滥用、恶意或欺骗性行为。

## 5. CSP 限制

MV3 扩展页面的默认策略：`script-src 'self'; object-src 'self';`，且 Chrome 强制最低标准，**不允许放宽**（加不了 `'unsafe-eval'`）。

| | |
|---|---|
| 本地打包脚本 | ✅ |
| 远程脚本（CDN） | ❌ |
| 内联脚本 | ❌ |
| `eval` / `new Function` | ❌ |
| WebAssembly | ❌ |

对本项目的影响：

- **React / Turndown / JSZip 必须打包进扩展**，不能从 CDN 加载。Vite 构建天然满足。
- ⚠️ **需要在实现阶段确认这些库不依赖 `eval` 或 `new Function`**。生产构建通常是干净的，但要实测——CSP 违规在扩展里是静默失败，很难排查。
- `sandbox` CSP 更宽松（允许 `unsafe-eval`），但沙盒页**无法访问扩展 API**，本项目用不上这个逃生舱。

## 6. `chrome.storage` 配额（给 #7 的输入）

- `storage.local`：**10 MB**（Chrome 113 及更早为 5 MB）。
- `storage.session`：10 MB（Chrome 111 及更早为 1 MB）。
- 超配额的写入**立即失败**，并置 `runtime.lastError`（回调式）或返回 rejected Promise（async/await）——不是静默截断，可以捕获并降级。
- `unlimitedStorage` 权限移除该上限，且 **`QUOTA_BYTES` 在有此权限时被忽略**。

**好消息**：`storage` 和 `unlimitedStorage` **都不产生安装警告**，可以放心声明。这让 #7 里「存不存 HTML 快照」的配额顾虑基本消失——但注意 `unlimitedStorage` 只对 `storage.local` 有效，`storage.session` 的 10MB 上限不受影响。

---

## manifest.json 权限清单草案

```json
{
  "manifest_version": 3,
  "name": "WeTrim",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "unlimitedStorage"
  ],
  "host_permissions": [
    "*://mmbiz.qpic.cn/*",
    "*://mmbiz.qlogo.cn/*"
  ],
  "action": {
    "default_title": "用 WeTrim 清洗这篇文章"
  },
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  }
}
```

| 条目 | 理由 | 安装警告文案 |
|---|---|---|
| `activeTab` | 用户点击图标后，临时获得当前文章页的访问权，用于注入 content script 读正文 DOM | **无** |
| `scripting` | `activeTab` 授权后，实际调用 `executeScript` 需要它 | **无** |
| `storage` | `chrome.storage.local` 持久化清洗进度（地图基线决策 8） | **无** |
| `unlimitedStorage` | 解除 10MB 上限，容纳整篇 HTML 快照（待 #7 确认是否真的需要） | **无** |
| `host_permissions` | service worker 跨域 fetch 图片，content script 做不到（见第 2 节） | 「读取和更改你在 mmbiz.qpic.cn、mmbiz.qlogo.cn 上的数据」 |
| ~~`downloads`~~ | 不声明。改用 File System Access API，零权限零警告 | — |
| `declarativeNetRequestWithHostAccess` | **暂不声明**。仅当 #4 实测确认图片需要 Referer 头才加 | 待确认 |

**净效果：安装时用户只会看到一条警告**，来自 `host_permissions`。

---

## 未解决 / 待实测

1. 微信图片是否真的需要 `Referer` 头？（→ #4）
2. `showDirectoryPicker` 在 `chrome-extension://` 顶级标签页里是否可用？（→ #4）
3. Turndown / JSZip / React 的生产构建是否完全不依赖 `eval`？（实现阶段）
4. `mmbiz.qlogo.cn` 是否真的会用到，还是所有正文图片都在 `mmbiz.qpic.cn`？（→ #4 顺带确认，能少一个域名就少一个）
5. host_permissions 里要不要顺带写上 `mp.weixin.qq.com` 以改善警告观感？（上架阶段的产品取舍，见第 2 节）

## 参考

- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) · [Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) · [Changes to Cross-Origin Requests in Chrome Extension Content Scripts](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/)
- [Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process) · [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
