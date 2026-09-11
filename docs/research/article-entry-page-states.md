# 文章入口：页面状态的可判定性

为[决策：文章入口与不可用页面的处理](https://github.com/dulltackle/WeTrim/issues/10)所做的核实。记录哪些页面状态可以靠事实可靠区分，哪些不能。

## 实测（2026-09-11）

用桌面 Chrome UA 直接请求两个格式合法但指向不存在文章的链接：

| 请求 | 结果 |
|---|---|
| `https://mp.weixin.qq.com/s/AAAAAAAAAAAAAAAAAAAAAA` | HTTP 200，31,729 字节，**不发生跳转** |
| `https://mp.weixin.qq.com/s?__biz=…&mid=…&idx=1&sn=…` | HTTP 200，但**先被 302 到** `/mp/wappoc_appmsgcaptcha?poc_token=…&target_url=<原文 URL>` |

### 提示页用的是统一的 WeUI 模板

第一个响应的正文片段：

```html
<div class="weui-msg">
  <div class="weui-msg__icon-area"><i class="weui-icon-warn weui-icon_msg"></i></div>
  <div class="weui-msg__text-area">
    <div class="weui-msg__title warn">参数错误</div>
  </div>
</div>
```

要点：

- 原因是一句**面向人的中文**，就放在 `.weui-msg__title.warn` 里。微信已经替我们写好了这句话，不需要我们再分类。
- 页面里**没有** `#js_content`，也没有 `#activity-name`。与正常文章页（选择器见 `docs/research/upstream-wechat-parsing.md`）结构上完全可分。
- `<title>` 为空，**不能**拿标题做判据。

### 验证页有独立路径与独立标识

第二个响应落到的页面：

- URL 路径 `/mp/wappoc_appmsgcaptcha`，查询参数 `poc_token` 与 `target_url`；`target_url` 原样保留了用户想看的文章 URL。
- 页面内联 `var PAGE_MID='mmbizwap:secitptpage/verify.html'`。
- 同样有 `.weui-msg` 容器，但提示内容由脚本后填，**首屏 HTML 里没有可转述的文案**。

值得注意的是：这次跳转发生在**没有任何用户交互**的情况下，纯粹因为请求来自一个非浏览器会话的直接抓取。这是「不做粘贴 URL 入口」最直接的证据（见 `docs/adr/0006-single-entry-from-article-tab.md`）。

## 可判定性结论

按可靠性从高到低，只承认三档：

1. **正常文章页** — 能注入且 `#js_content` 存在。
2. **微信提示页** — 能注入、无 `#js_content`、但有 `.weui-msg`，且 `.weui-msg__title` 有非空文案 → 原样转述该文案。
3. **其余一律通用提示** — 注入失败（`chrome://`、网上应用店、其他扩展页等受限页面）、非微信页面、微信的非文章页面、以及验证页首屏。统一说「这个页面上没找到公众号文章正文」，不猜是删除、违规还是需要登录。

验证页是第 3 档里唯一单独给路径的子情况：靠 URL 路径可判，提示用户回到原文自己完成验证。**不代替用户完成验证。**

判定「页面是否可注入」不需要 `tabs` 权限：尝试 `chrome.scripting.executeScript` 并捕获失败即可，失败本身就是信号。

## 未核实 / 边界

- **只观察到「参数错误」一种提示文案。** 「该内容已被发布者删除」「此内容因违规无法查看」等落在同一个 WeUI 模板里，是**基于模板一致性的推断**，没有真实样本。判定逻辑因此不能匹配具体文案，只能判断 `.weui-msg__title` 是否存在且非空——这也正是「原样转述」这个口径天然成立的原因。
- 本次是**服务端直接请求**，不是在真实浏览器标签页里注入 content script。已登录的真实浏览器会话遇到同类链接时，提示文案可能不同；但「有 `.weui-msg` 无 `#js_content`」这个结构判据不依赖于此。
- 未测试文章页加载未完成时的中间态 DOM。点击图标后的内容稳定探测（正文文本长度与 `img[data-src]` 数量在约 300 ms 内不再增长，最多等约 2 秒）是依据 `docs/research/upstream-wechat-parsing.md`「真实地址预写进 `data-src`、无需滚动」这一事实所做的设计，**尚未实测**。
