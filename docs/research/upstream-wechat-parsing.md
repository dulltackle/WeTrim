# 调研：上游项目的爬取、解析与转换规则

- 对应 issue: [#2 调研：上游项目的爬取、解析与转换规则](https://github.com/dulltackle/WeTrim/issues/2)（背景见 [#1 地图](https://github.com/dulltackle/WeTrim/issues/1)）
- 调研对象：[`jackwener/wechat-article-to-markdown`](https://github.com/jackwener/wechat-article-to-markdown)
- 调研基线：`main` 分支 commit `50b7e63c`（2026-03-22，"fix(cli): normalize pasted WeChat URLs (#4)"）
- 调研方法：直接读取上游源码（`wechat_article_to_markdown.py`、`main.py`、`README.md`、`SKILL.md`、`tests/`），并读取全部 issue / PR（含未合并的 PR，它们记录了已知但尚未修复的 bug）
- **重要前提**：本项目不用上游的代码（Python + Camoufox 反检测浏览器），只移植它对「微信文章 HTML 长什么样、怎么踩坑」的知识。下文每一条都会单独给出"我们在浏览器扩展 JS 里该怎么做"的结论，不是 Python 逐句翻译。

---

## 0. 上游整体架构一览

一个单文件脚本 `wechat_article_to_markdown.py`（415 行）+ 入口 `main.py`：

1. 用 Camoufox（反检测 Firefox）打开文章 URL，等正文选择器出现 + 固定 `sleep(2)`，拿到 `page.content()` 的完整 HTML；
2. 用 BeautifulSoup 解析该 HTML，提取标题/作者/时间等元数据；
3. 对正文容器做少量预处理（图片 `data-src`→`src`、抽代码块占位、删噪声标签）；
4. 用 `markdownify` 把预处理后的正文 HTML 整体转成 Markdown；
5. 用 `httpx` 并发下载图片，替换 Markdown 里的图片链接为本地路径；
6. 拼 front-matter 风格的头部信息，写文件。

这个架构里，第 1 步（反检测浏览器）在我们的浏览器扩展场景下**整个不存在**——用户在自己已登录的真实浏览器里打开文章页，content script 直接拿 `document`，没有反爬问题。第 2-6 步的"知识"（选择器、噪声清单、代码块结构、图片属性、时间戳格式、已知 bug）才是我们要移植的部分。

---

## 1. 正文定位

**上游怎么做**

- 正文容器：`#js_content`（`wechat_article_to_markdown.py:202`，`content_el = soup.select_one("#js_content")`）。
- 标题：`#activity-name`（`extract_metadata`，`wechat_article_to_markdown.py:188`）。
- 作者/公众号名：`#js_name`（同上，`:189`）。
- 正文内噪声移除（`process_content`，`wechat_article_to_markdown.py:237-240`）：

  ```python
  for sel in ("script", "style", ".qr_code_pc", ".reward_area"):
      for tag in content_el.select(sel):
          tag.decompose()
  ```

  即只删了 4 类：`<script>`、`<style>`、二维码/PC 引导 `.qr_code_pc`、赞赏区 `.reward_area`。
- 另外 PR #13（未合并，见「踩坑」一节）补了第 5 类噪声：`js_darkmode__N` 暗黑模式占位 `<pre>`（空文本，但因为 `pre` 在 markdownify 的 `convert` 白名单里，会被转成一个空的 ` ``` ` 代码围栏）。

**上游没做、issue 里也没提到的**：作者原话列出的「关注引导」「留言区」在源码和 issue 里都**未找到**对应选择器——上游没有专门处理这两类元素，它的清洗粒度明显比 issue 里设想的粗（可能是因为这些区块在 `#js_content` 之外，微信公众号页面把"关注公众号"引导条、留言区渲染在正文容器外层的兄弟节点里，天然不会被 `#js_content` 选择器带进来）。`mp-common-profile` 同样**未找到**——这大概率也是正文容器外的元素。

**我们在 JS 里该怎么做**

- 正文容器选择器直接复用：`document.querySelector('#js_content')`。这是微信公众号页面的稳定结构，Content script 抓 DOM 快照时以它为根。
- 噪声剔除清单可以直接照抄这 5 个选择器作为默认排除规则：`script`、`style`、`.qr_code_pc`、`.reward_area`、以及文本为空的 `pre[class*="js_darkmode"]`。
- 但因为我们的产品形态是「按内容块逐块保留/剔除」（[#1] 基线决策 6），而不是一次性全自动清洗，这份清单的实际作用是**默认建议值**：块切分时可以给这几类元素打上"建议剔除"的标记，而不是像上游一样直接 `decompose()` 硬删——用户仍能在扩展页里把它们勾回来。这比上游的做法更安全，因为上游的清洗粒度本来就没有覆盖到「关注引导」「留言区」这些块，我们需要在实测中自己补全这份清单，不能假设上游的 4-5 个选择器是完整的。

---

## 2. 元数据提取

**上游怎么做**（`extract_metadata` + `extract_publish_time`，`wechat_article_to_markdown.py:80-113`, `186-194`）

| 字段 | 来源 | 备注 |
|---|---|---|
| `title` | `#activity-name` 文本 | `.get_text(strip=True)` |
| `author`（公众号名） | `#js_name` 文本 | 同上 |
| `publish_time` | 内联 `<script>` 里的 `create_time` 变量 | 见下 |
| `source_url` | 不从 DOM 取，直接用调用方传入的原始 URL（`meta["source_url"] = url`，`main.py` 逻辑在 `fetch_article` 里，`wechat_article_to_markdown.py:351`） | |

`create_time` 的解析要兼容三种写法（正则依次尝试，`wechat_article_to_markdown.py:80-103`）：

```python
m = re.search(r"create_time\s*:\s*JsDecode\('([^']+)'\)", html)   # JsDecode('...') 形式
m = re.search(r"create_time\s*:\s*'(\d+)'", html)                  # 纯数字字符串
m = re.search(r'create_time\s*[:=]\s*["\']?(\d+)["\']?', html)     # 冒号或等号赋值
```

时间戳格式化（`format_timestamp`，`:106-112`）：

```python
tz = timezone(timedelta(hours=8))          # Asia/Shanghai, UTC+8，硬编码
dt = datetime.fromtimestamp(ts, tz=tz)
return dt.strftime("%Y-%m-%d %H:%M:%S")
```

即：`create_time` 是 **Unix 秒级时间戳**，微信公众号页面固定按北京时间（UTC+8）展示/存储，上游硬编码了 `+8` 时区转换，不做时区自适应。

Front-matter：**上游根本不用 YAML front-matter**，而是纯 Markdown 头部（`build_markdown`，`wechat_article_to_markdown.py:291-303`）：

```markdown
# {title}

> 公众号: {author}
> 发布时间: {publish_time}
> 原文链接: {source_url}

---
{正文}
```

三行 blockquote 都是可选的（`meta.get(...)` 判空才加）。

**踩坑历史（closed PR #1、#3，已合并进当前 main）**：`create_time` 的解析踩过两次坑，说明这个字段比看起来脆弱：
- PR #1：`create_time` 值可能已经是 `"2026-03-02 07:59"` 这种日期字符串（不是纯数字），当时的代码把它当秒级时间戳硬转，产出 1970 年的错误日期。
- PR #3：`JsDecode(...)` 里的引号可能被 HTML 实体转义成 `&#39;`／`&apos;`／`&quot;`；数字可能是 13 位毫秒级而非 10 位秒级，需要按位数区分（10 位→秒，13 位→毫秒转秒，其他位数直接拒绝避免离谱的未来日期）；日期还可能是中文格式 `YYYY年MM月DD日`。

**我们在 JS 里该怎么做**

- 选择器直接复用：`document.querySelector('#activity-name')?.textContent.trim()`、`document.querySelector('#js_name')?.textContent.trim()`。
- `create_time`：微信页面的内联 `<script>` 变量在浏览器扩展场景下更好拿——不需要正则啃整段 HTML 字符串，可以直接在 content script 里读页面已经执行过的全局变量（微信文章页把这些赋值挂在 `window` 作用域的顶层 `<script>` 里，具体变量名以实测页面为准，`create_time` / `createTime` 都要检查），或者退化成对 `document.documentElement.outerHTML` 做上游同款的三条正则兜底。
- 时间戳解析要按上游踩过的坑复原防御逻辑，不能只处理"纯 10 位数字"这一种情况：
  - 数字位数分支：10 位当秒、13 位当毫秒（`/1000`）、其他位数丢弃防止解析出离谱日期；
  - 值本身可能已经是日期字符串（`YYYY-MM-DD HH:mm[:ss]` 或 `YYYY年MM月DD日`），要先判断"是不是纯数字"再决定走时间戳分支还是字符串直通分支；
  - HTML 实体解码要在正则匹配前做（`&#39;` → `'` 等），否则 `JsDecode('...')` 形式的引号会匹配不上——JS 里用 `DOMParser` 解析一段 HTML 片段拿 `textContent`，或用一个实体表替换，都比 Python 的 `html.unescape` 更自然。
  - 时区固定按 UTC+8（Asia/Shanghai）计算，不要用运行环境（用户浏览器）的本地时区——公众号后台固定用北京时间生成这个时间戳，跟用户所在时区无关。JS 里不能像 Python `datetime.fromtimestamp(ts, tz=...)` 那样一步到位，需要手算：`new Date((ts + 8*3600) * 1000).toISOString()` 再去掉时区标记取日期时间部分，或用 `Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', ...})` 格式化。
- `source_url`：不需要从 DOM 猜，浏览器扩展场景下就是 content script 所在的 `location.href`（比上游更可靠，上游是因为 Python CLI 拿到的是用户粘贴的 URL，两者语义一致）。
- Front-matter：这条决策留给开发者——上游给的是纯 Markdown 头（标题 + 3 行 blockquote + `---`），**不是** YAML front-matter，如果本项目要导出 Obsidian 友好的 YAML front-matter，需要自己设计字段名，不能照抄上游格式。

---

## 3. 图片处理

**上游怎么做**

- 图片 URL 属性：微信懒加载把真实地址放在 `data-src`，先统一搬到 `src`（`process_content`，`wechat_article_to_markdown.py:206-210`）：

  ```python
  for img in content_el.find_all("img"):
      data_src = img.get("data-src")
      if data_src:
          img["src"] = data_src
  ```

  即：**优先信 `data-src`，`data-src` 不存在才退回 `src`**（因为这行只在 `data_src` 有值时才覆盖）。

- `wx_fmt` 查询参数：不做任何清洗/剥离，只用来**猜文件扩展名**（`download_image`，`wechat_article_to_markdown.py:132-136`）：

  ```python
  ext_match = re.search(r"wx_fmt=(\w+)", url) or re.search(r"\.(\w{3,4})(?:\?|$)", url)
  ext = ext_match.group(1) if ext_match else "png"
  ```

  优先级：`wx_fmt=xxx` 参数 > URL 路径里的扩展名 > 兜底 `png`。URL 本身（含 `wx_fmt` 等全部查询参数）原样保留用于下载，不做裁剪。

- 防盗链：下载请求只加了一个 `Referer` 头（`download_image`，`:141-145`）：

  ```python
  resp = await client.get(url, headers={"Referer": "https://mp.weixin.qq.com/"}, timeout=15.0)
  ```

  没有 UA 伪装、没有 Cookie 透传，也没有其他防盗链相关处理——说明微信图片 CDN（`mmbiz.qpic.cn` 等域名）的防盗链校验目前只认 `Referer`。另外处理了协议相对 URL：`//xxx` → 补 `https:`（`:130`）。

- 文件名与去重：顺序编号 `img_{index:03d}.{ext}`（`:138`），index 是"去重后 URL 列表"里的顺序号，不含 hash、不含原文件名。去重发生在收集阶段（`process_content` 末尾，`:243-249`）：

  ```python
  img_urls = []
  seen = set()
  for img in content_el.find_all("img", src=True):
      src = img["src"]
      if src not in seen:
          seen.add(src)
          img_urls.append(src)
  ```

  即**按完整 URL 字符串去重**（不是按图片内容 MD5）。PR #7（未合并）指出这个粒度不够——跨文章共享的图片会重复下载重复存储，它加了一个独立脚本 `wechat-dedup.py` 做「导入 Obsidian 时按 MD5 二次去重」，但这是在 markdown 已生成之后的离线后处理，不在核心抓取流程里。

- Markdown 里的引用改写：不依赖 Markdown 层面的 URL 解析，而是**精确字符串匹配 + 转义**（`replace_image_urls`，`wechat_article_to_markdown.py:282-288`）：

  ```python
  pattern = re.compile(r"!\[([^\]]*)\]\(" + re.escape(remote_url) + r"\)")
  md = pattern.sub(lambda m: f"![{m.group(1)}]({local_path})", md)
  ```

  单测 `test_replace_image_urls_handles_parentheses`（`test_core.py:81-93`）专门验证了 URL 里带括号 `(1).png`、带查询参数 `?x=1&y=2` 时替换不出错——这是因为 Markdown 图片语法 `![alt](url)` 本身用括号包 URL，如果 URL 里含未转义括号，朴素的正则替换会在括号处提前截断，所以必须先 `re.escape` 整个原始 URL 再作为字面量匹配，不能用"通用图片链接正则"去猜。

**我们在 JS 里该怎么做**

- 属性优先级复用：读图片块时 `img.dataset.src || img.src`（`data-src` 优先，没有才退回 `src`）。
- `wx_fmt` 只用来推断扩展名，不需要清洗掉；扩展名推断顺序：先从 URL 查询串取 `wx_fmt`，取不到再看路径扩展名，最后兜底 `png`。JS 里用 `new URL(src).searchParams.get('wx_fmt')` 比正则更稳。
- 下载图片时必须带 `Referer: https://mp.weixin.qq.com/`——但**浏览器扩展场景下这一条要重新验证**，不能照搬结论：
  - 如果用 content script 里的 `fetch()`/`<img>` 直接加载，浏览器会自动带上当前页面（`mp.weixin.qq.com`）作为 Referer，天然满足防盗链，不需要手动设置头；
  - 如果导出阶段在扩展的其他上下文（background/扩展页）里发起下载，跨源请求可能拿不到正确的 Referer，这时才需要 MV3 的 `declarativeNetRequest` 规则去改写请求头,或者干脆在 content script（页面上下文）里完成图片下载再把二进制传给扩展页,避免额外的头伪装逻辑。这是本项工程实现阶段要验证的点，调研阶段只能确认"上游只需要 Referer 这一个头"这一事实，**不能确认**浏览器扩展的哪个执行上下文能最省事地满足它。
- 协议相对 URL（`//xxx`）记得补 `https:` 前缀，这是微信页面真实存在的写法。
- 文件名/去重：MVP 阶段可以照抄"按完整 URL 去重 + 顺序编号"这个最简单的方案（`img_001.png`、`img_002.png`……）。**MD5 去重（PR #7 的思路）是"跨文章共享图片"场景才需要的优化**，而 [#1] 已经把"多篇文章管理"划进 Out of scope（本工具只处理"当前这一篇"），所以这条上游经验**不适用**，不用现在做。
- Markdown 图片链接替换：如果本项目的转换是"按块处理"（[#1] 基线决策 6：从 DOM 逐块转，不是先转整篇 Markdown 再全文替换），这个坑天然不存在——图片块转换时直接用本地路径生成 `![alt](local_path)`，不需要在生成后的 Markdown 文本里做字符串替换。这是我们架构上"按块转换"相对上游"整篇转换再替换"的一个天然优势，值得在实现时确认没有绕回"先整篇转换"的写法。

---

## 4. 微信特有 DOM 结构的转换规则

**上游怎么做**——这是本次调研里最需要澄清预期的一条：**上游对代码块之外的微信特有结构（行内代码、公式、表格、引用、列表、`js_darkmode` 内联样式）没有做任何专门识别或清洗**，全部依赖 `markdownify` 库对通用 HTML 标签的默认转换规则兜底。具体：

- **代码块**：唯一被专门处理的结构。选择器是 `.code-snippet__fix`（`process_content`，`wechat_article_to_markdown.py:213-235`）：
  1. 先删掉行号节点 `.code-snippet__line-index`（`:216-217`）；
  2. 语言从 `pre[data-lang]` 的 `data-lang` 属性取（`:219-220`）；
  3. 遍历内部所有 `<code>` 标签取文本拼接成多行代码（`:222-228`），但要**跳过 CSS `counter(line...)` 泄漏的垃圾行**——正则 `^[ce]?ounter\(line`（`:226`，注意这个正则本身带一个小 bug：`[ce]?` 意图是同时匹配 `counter(` 和 `ounter(`，防止 `content: counter(...)` 的 CSS 文本被 BeautifulSoup 提取 `.get_text()` 时把 `c` 吞掉的边界情况）；
  4. 整个 `.code-snippet__fix` 元素被替换成占位符 `<p>CODEBLOCK-PLACEHOLDER-{n}</p>`（`:233-235`），markdownify 转换完之后再用占位符字符串替换回围栏代码块（`convert_to_markdown`，`:266-270`）。
  5. **PR #13（未合并）指出这个占位符方案有严重 bug**：`CODEBLOCK-PLACEHOLDER-1` 是 `CODEBLOCK-PLACEHOLDER-10`…`-19` 的前缀，用 `str.replace()` 顺序替换时，替换到 `i=1` 会把 10-19 号占位符也吃掉前缀，导致第 10 个及以后的代码块内容错位/丢失、残留孤立数字行。40 个代码块的真实文章只有前 10 个能正常还原。修复方式是给占位符加终止分隔符（如 `CODEBLOCK-PLACEHOLDER-{n}-END`）。
  6. **同一个 PR 还指出**：微信会在 `#js_content` 里插入 `<pre class="js_darkmode__N">` 暗黑模式样式载体，内部没有文本，且不在 `.code-snippet__fix` 内，因此代码块抽取逻辑会跳过它们；但 `pre` 在 markdownify 的 `convert` 白名单里，于是每一个这样的空 `<pre>` 都会被转成一个空的 ` ``` ` 代码围栏。40 个代码块的文章里出现了 19 个这种空围栏。修复方式是在噪声清除阶段一并删掉"无文本的 `<pre>`"。

- **行内代码 / 公式 / 表格 / 引用 / 列表**：`process_content` 里**没有任何针对它们的选择器或预处理**。`convert_to_markdown` 只是把 `table/thead/tbody/tr/th/td`、`blockquote`、`ul/ol/li` 列入 markdownify 的 `convert` 白名单（`:260-263`），交给 markdownify 按标准 HTML 语义转换。公式**完全未提及**——微信公众号如果用图片渲染公式（LaTeX 截图），会被当成普通 `<img>` 处理；如果用 MathML/专有 `<section>` 结构渲染，上游**没有识别逻辑**，会转换失败或被 markdownify 忽略成空文本。README 的 Limitations 里也明确写了"部分代码片段是图片/SVG 渲染，无法提取为源码"（`README.md:63`），侧面印证微信正文里"看起来是代码/公式，实际是图片"的情况上游选择放弃，不做 OCR 或特殊处理。

- **嵌套 `<section>` 拍平 / 属性清洗**：**未找到**任何"删除多余 style 属性"或"拍平嵌套 section"的预处理步骤。上游完全依赖 markdownify 库自己的 HTML→Markdown 转换来处理微信编辑器典型的"`<section>` 套 `<section>` 套 `<span style="...">`"结构；markdownify 默认行为是忽略它不认识的标签（`section`、`span` 都不在 `convert` 白名单里，会被当成"透明容器"处理，只保留其文本内容和子节点），所以嵌套结构和内联样式在转换后**自然消失**，不需要显式拍平——这依赖的是 markdownify 库"白名单转换、非白名单标签直接拆掉只留内容"的默认行为，而不是上游写了什么清洗代码。

**我们在 JS 里该怎么做**

- 代码块识别选择器可以直接复用：`.code-snippet__fix` 容器、`.code-snippet__line-index`（行号，需要剔除）、`pre[data-lang]`（语言来源）、内部多个 `<code>` 标签拼接。跳过 CSS counter 泄漏文本的判断逻辑也要移植，但正则可以写得更准确（不需要照抄 `[ce]?ounter\(line` 这个上游自己都不确定的 hack，直接判断 `text.trim().startsWith('counter(line')` 或类似字符串前缀更清晰）。
- **必须主动补上上游 PR #13 里发现的两个坑**，因为它们在上游 main 分支尚未修复：
  1. 如果本项目也用"占位符字符串 + 事后替换"的两阶段转换（先转 HTML 片段，再回填代码块），占位符必须要有清晰的开始/结束边界（比如用 UUID，或者干脆不走占位符方案——因为本项目是"按块转换"，代码块本身就是独立的一个块，不需要在一大段 Markdown 文本里做占位符替换，这个 bug 类别天然不存在，只要每块单独转换、不拼接后再替换）；
  2. 噪声清单里要加一条：`js_darkmode__` 前缀 class 且文本内容为空的 `<pre>` 直接跳过/标记为"建议剔除"，避免转换出空代码围栏。
- 行内代码、表格、引用、列表：这几类微信文章里常见，但上游**没有特殊处理**，说明它们在微信编辑器里生成的 HTML 足够"标准"（`<code>`、`<table>`、`<blockquote>`、`<ul>/<ol>/<li>`），可以直接交给通用 HTML→Markdown 转换逻辑（JS 里可以用 `turndown` 之类的库，或者手写按标签规则递归转换），**不需要**为它们单独写微信专属的识别规则。这条结论的置信度低于代码块——上游没做不等于没坑，只是上游没踩到/没记录，实现阶段仍要拿真实文章验证表格、引用的实际 DOM 结构是否真的"标准"。
- 公式：上游对此**没有任何处理**，等同于"未验证"。如果微信文章里的公式是图片，走图片块的通用逻辑即可；如果是特殊标记语言渲染，需要在我们自己的实现里单独调研 DOM 结构，不能指望上游经验。
- 嵌套 `<section>` / 内联 `style`：不需要写"拍平"代码，只要确保我们的 HTML→Markdown 转换逻辑对不认识的标签（`section`、大部分 `span`）采取"忽略标签本身、保留子内容"的策略，效果等同于上游依赖 markdownify 默认行为达成的效果。这是转换器整体设计要遵守的一条通用规则，不是针对微信的特殊规则。

---

## 5. 爬取逻辑（页面加载完成的判断信号）

**上游怎么做**（`fetch_article`，`wechat_article_to_markdown.py:326-336`）

```python
async with AsyncCamoufox(headless=True) as browser:
    page = await browser.new_page()
    await page.goto(url, wait_until="domcontentloaded")
    try:
        await page.wait_for_selector("#js_content", timeout=10000)
    except Exception:
        pass  # 超时也继续尝试解析
    await asyncio.sleep(2)          # 额外等待确保 JS 执行完毕
    html = await page.content()
```

三层判断信号，缺一都会导致正文不完整或元数据缺失：

1. `wait_until="domcontentloaded"`——不等 `load` 或 `networkidle`，只等 DOM 解析完成，说明微信文章页的资源加载（图片、字体等）不影响正文可读性，没必要等到底；
2. 显式等待 `#js_content` 选择器出现，超时（10s）也不报错、继续往下走——这是"尽力而为"策略，容忍正文加载慢的情况；
3. **固定 `sleep(2)` 兜底**——即使选择器已出现，仍无条件多等 2 秒，这是因为微信页面在 `#js_content` 挂载之后，还有内联 `<script>` 继续执行（填充 `create_time` 等变量、把 `data-src` 相关的懒加载逻辑挂上事件监听），过早截取 HTML 可能拿到"容器有了但内容/元数据还没填完"的中间态。

**没有滚动触发懒加载的动作**——全文找不到任何 `page.mouse.wheel` / `page.evaluate("window.scrollTo...")` 之类的滚动代码。这意味着微信文章页的图片懒加载用的是"页面加载时把真实地址预先写进 `data-src`"，而不是"滚动到可视区域时才用 JS 请求真实地址"——所以不需要滚动，直接读 `data-src` 属性就能拿到全部图片的真实 URL，不管它们是否曾经出现在视口里。

PR #11（未合并）额外提供了一条真实验证记录：默认 30 秒的导航超时在网络慢或首次启动浏览器慢时不够用，实测某篇文章需要 120 秒才能正常打开并提取到 `#js_content`（否则报 `Page.goto: Timeout 30000ms exceeded`）。这条经验主要指向 Camoufox/Playwright 的导航超时配置，和"正文是否完整"这个问题本身关系不大，但说明**微信文章页的加载时间波动很大**，不能假设几秒内一定完成。

**我们在 JS 里该怎么做**

- "什么时候正文才算完整"这条经验可以直接复用，翻译成 content script 的等待策略：
  1. 不需要等 `window.onload`（对应 `domcontentloaded` 已够用的结论）；
  2. 等待 `#js_content` 出现在 DOM 里（可以用 `MutationObserver` 或轮询 `document.querySelector`，超时后也继续走降级路径，而不是直接报错）；
  3. **即使 `#js_content` 已经出现，仍建议再等待一小段时间**（上游用固定 2 秒，我们可以换成更精确的信号：例如轮询 `create_time` 相关的内联变量是否已经赋值到位，或者等待 `#js_content` 内部 `<img>` 的 `data-src` 属性数量不再增长，这类"内容稳定"探测比固定 sleep 更适合浏览器扩展场景，因为用户手动点击扩展图标的时机通常晚于页面首次渲染，可以适当缩短甚至去掉这个固定等待，但保留"检测内容是否仍在变化"的思路）。
- 图片懒加载不需要模拟滚动——这条对我们是好消息：content script 抓取时不用先滚一遍页面，直接读 `img[data-src]` 就能拿到全部图片真实地址，简化了实现。但如果后续实测发现某些图片确实需要进入视口才写入 `data-src`（上游作者可能只在自己测试的文章样本上验证过），要在真实文章上二次确认这条结论，不能盲目全信。
- 加载耗时波动大这条经验，在浏览器扩展场景下影响方式不同：用户是在页面已经打开、自己看着加载完成之后才点击扩展图标，不存在"扩展要等页面从零加载到可交互"的场景，所以 PR #11 的"导航超时"问题**不适用于我们**（这是 Camoufox 冷启动 + 无头导航特有的问题）；但"内容稳定判断"仍然有必要，因为用户可能在图片还在稍晚加载、或者页面刚跳转还没完全渲染完的瞬间就点了扩展图标。

---

## 6. 踩坑记录

上游仓库没有独立的 CHANGELOG 文件（仓库里**未找到** `CHANGELOG.md`），踩坑记录分散在 issue / PR 里。已读取全部 13 个 issue/PR（含 closed），按是否已合并整理：

### 已合并进 main 的修复（说明这些坑上游已经解决，我们要么复用结论，要么确认"浏览器扩展场景下问题不存在"）

| # | 标题 | 坑 | 我们是否受影响 |
|---|---|---|---|
| #1 | Fix WeChat anti-bot request headers and publish time parsing | 直接 HTTP 请求经常被判定为反爬、拿到验证页；`create_time` 曾被误当纯数字时间戳解析出 1970 年 | **不受影响**——真实浏览器请求不存在反爬判定问题（这正是 [#1] 定下"浏览器扩展"路线的理由）；时间戳解析的坑本身要移植，见第 2 节 |
| #3 | fix: harden publish time parsing for JsDecode variants | `JsDecode(...)` 引号被 HTML 实体转义、13 位毫秒时间戳被误当秒解析 | **要移植**，见第 2 节已展开 |
| #4 | fix(cli): normalize pasted WeChat URLs | CLI 场景下用户粘贴 URL 可能带终端转义反斜杠、HTML 实体、缺 scheme | **不适用**——这是"用户手动粘贴 URL 到命令行"的坑，浏览器扩展里 URL 来自 `location.href`，不存在粘贴转义问题 |
| #5 | feat: add -o/--output parameter | CLI 输出目录可配置 | **不适用**——CLI 参数设计，与浏览器扩展导出交互无关 |
| #6 | （closed，与 #7 同名，推测是 #7 的前一版 PR） | — | 见 #7 |

### 尚未合并的 PR（已知问题，但上游还没修，我们要主动避免而不是"照抄现状"）

| # | 标题 | 坑 | 我们要怎么做 |
|---|---|---|---|
| **#13** | fix: restore code blocks beyond the 9th and drop empty darkmode `<pre>` | ①占位符前缀碰撞导致第 10 个及以后代码块损坏；②空 `js_darkmode__N` `<pre>` 转出空代码围栏 | **必须主动规避**，见第 4 节。这是本次调研里最关键的一条"未修复已知 bug"，如果不看这条未合并 PR，只看 main 分支代码是发现不了的 |
| #11 | Add configurable navigation timeout | Camoufox 导航默认 30 秒超时不够，实测需要 120 秒 | **不适用**（反检测浏览器冷启动问题，浏览器扩展场景不存在导航超时概念），但佐证第 5 节"加载耗时波动大"的结论 |
| #12 | Pin Playwright below 1.61 | Camoufox/Playwright 版本兼容性问题，`Browser.new_page` 报错 | **完全不适用**——纯 Python 依赖管理问题 |
| #7 | feat: add image deduplication and Obsidian import support | 跨文章共享图片重复下载存储；`.wechat-images/` 点号前缀目录被 Obsidian 忽略 | **暂不适用**——[#1] 已把"多篇文章管理/图片去重"划进 Out of scope，只有未来做历史文章库时才需要重新评估这条经验 |

### 普通用户反馈类 issue（非 PR，反映真实使用中的失败场景）

| # | 标题 | 内容 | 对我们的启示 |
|---|---|---|---|
| #2 | 好像失败了 | 用户报告"未能提取到文章标题，可能触发了验证码"，这是 `main.py` 里标题提取失败的兜底提示（`wechat_article_to_markdown.py:343-349`，会把原始 HTML 存成 `debug.html` 方便排查） | 我们应该有类似的"提取失败时的诊断信息"，例如块解析阶段如果 `#activity-name`/`#js_content` 选择器找不到元素，要给用户明确提示"页面可能还没加载完成"或"页面结构不符合预期"，而不是静默失败 |
| #8 | 请问怎么修改文章的输出路径？ | Windows 下 CLI 默认输出目录不符合用户预期 | **不适用**——CLI 特有的路径配置问题，浏览器扩展导出走 `chrome.downloads` API，用户体验完全不同 |
| #9 | 第一次成功，再次执行失败 | Camoufox 首次运行需要下载约 300MB 的浏览器包 + 一个 uBlock Origin 扩展包（`addons.mozilla.org`），第二次运行时因网络问题下载中断导致 `manifest.json is missing` | **完全不适用**——这正是 [#1] 基线决策 1 里"Camoufox 约 300-400MB 定制编译 Firefox + 反爬风险"这条要规避的成本的真实案例，反过来印证了"浏览器扩展路线不需要这套东西"的判断是对的 |
| #10 | 是否可以把命令行改得简短一点 | CLI 易用性反馈 | **不适用** |

**未找到的内容**：上游仓库没有 `CHANGELOG.md`，也没有 Wiki 或 Discussions 区（`gh api` 未返回相关内容）；除上述 13 个 issue/PR 外没有其他历史记录可查。

---

## 结论摘要（给驱动地图的开发者）

1. 正文/元数据的选择器（`#js_content` / `#activity-name` / `#js_name`）可以直接复用，但噪声清单（`script`/`style`/`.qr_code_pc`/`.reward_area`/空 `js_darkmode` `<pre>`）不完整，issue 里提到的「关注引导」「留言区」「`mp-common-profile`」需要在实测中自己补充选择器。
2. 时间戳解析要照抄上游踩过的全部坑（位数判断、HTML 实体解码、字符串直通、UTC+8 硬编码时区），这是唯一一处"业务逻辑本身就该跨语言复用"的地方，因为它是微信平台的数据格式，不是 Python 实现细节。
3. 图片处理三条可直接复用：`data-src` 优先、`wx_fmt` 只用来猜扩展名、下载防盗链只需要 `Referer` 头（浏览器扩展里这条需要在实现阶段确认哪个执行上下文能自动满足）。图片去重上游只做了"按 URL 去重"，MD5 去重是跨文章场景才需要，本项目 MVP 不需要。
4. 转换规则里**唯一**被上游认真处理的微信特有结构是代码块（`.code-snippet__fix`），且这部分还有一个尚未合并的已知 bug（占位符前缀碰撞、空 darkmode `<pre>`）必须在我们自己的实现里主动规避。表格/引用/列表/行内代码没有特殊规则，公式完全没提及——这几类需要在实现阶段用真实文章补充验证，不能假设上游"没做"等于"没坑"。
5. 页面加载完成的判断信号（不等 `load`、等 `#js_content` 选择器、超时也继续、还要再等内容稳定）可以复用，但不需要模拟滚动（微信懒加载图片的 `data-src` 在加载时已经写好，不靠滚动触发）；反检测相关的坑（反爬验证页、Camoufox 冷启动 300MB 下载失败、导航超时）全部因为"用真实浏览器"这个架构决策而自动消失。
