# 每个内容块独立转换，不做整篇占位符回填

WeTrim 的 HTML → Markdown 转换以 Turndown 为基座，但转换的**单位是单个内容块**：切块先于转换，每块拿着自己那段 `originalHtml` 独立转换出 `initialMarkdown`，全篇 Markdown 只在导出和「检查结果」时由保留块的当前内容拼接而成。任何「先把整篇转成 Markdown，再用占位符把代码块之类的特殊结构替换回去」的两阶段方案都被排除。

这条看上去只是实现顺序，实际上消掉了一整类 bug。上游 `jackwener/wechat-article-to-markdown` 正是走的两阶段方案：把每个 `.code-snippet__fix` 替换成 `<p>CODEBLOCK-PLACEHOLDER-{n}</p>`，转换完再用 `str.replace()` 逐个换回去。而 `CODEBLOCK-PLACEHOLDER-1` 是 `-10`…`-19` 的前缀，顺序替换会把它们吃掉——一篇 40 个代码块的真实文章只有前 10 个存活，其余错位、丢失并残留孤立数字行。上游 PR #13 至今未合并。按块转换之后这个 bug 类别不存在，因为没有「在一大段 Markdown 文本里做字符串替换」这个步骤，但前提是后续实现不要为了别的理由把占位符方案重新引进来。

它同时是产品模型的直接要求，不只是防御。内容块是用户独立取舍与编辑的单位（ADR-0001），每块要保存互不相同的 `originalHtml`、`initialMarkdown` 与当前编辑三份文本（[决策：长文处理的性能目标与实现边界](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026)），「还原内容」要能把单块恢复到它首次转换的结果——这些都要求转换产物从一开始就是按块分开的。整篇转换再切分会让「哪段 Markdown 属于哪个块」变成一道需要反向匹配的题，而块身份恰恰不允许依赖内容匹配（ADR-0002）。

代价是转换器拿不到跨块上下文。Markdown 的引用式图片定义若跨块分布，逐块转换看不见它——因此导出时的图片识别与重写**以合成后的正文**处理引用定义，而不是逐块正则替换（[决策：导出产物的精确形态](https://github.com/dulltackle/WeTrim/issues/6#issuecomment-5581985012)）。另一处代价是每块都要独立处理 Turndown 的转义与首尾空白，块之间的衔接由拼接规则统一负责：块边界以一个空行连接，块内部的换行、缩进与硬换行原样保留。

决策来源：[整合：重写 mvp.md 为浏览器扩展版技术方案](https://github.com/dulltackle/WeTrim/issues/8)，依据[上游调研结论](https://github.com/dulltackle/WeTrim/issues/2#issuecomment-5557765738)记录的占位符前缀碰撞。规则清单见 `docs/conversion-rules.md`。
