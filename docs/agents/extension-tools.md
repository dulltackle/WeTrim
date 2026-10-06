# 扩展工具与权限约定

## 文章入口与授权

遵循 [ADR-0006](../adr/0006-single-entry-from-article-tab.md)：文章由用户已打开的文章标签页进入。
用户点击扩展图标触发 action 后，`activeTab` 在该标签页上的有效授权允许读取 URL、标题和 favicon；配合 `scripting` 可注入打包的抓取脚本。当前标签页本身不代表有授权。跨源导航或关闭标签页会撤销授权，同源导航可保留；受限页面不因此开放。

没有有效授权的后台读取不能假设 URL 可用，应请用户在文章页再次点击图标。读取 URL 也可以有 `tabs` 或匹配主机权限作为依据，但本项目没有这类文章获取需求，不为读取 `tab.url` 新增 `tabs` 或文章域名权限。侧栏或 popup 内按钮不自行授予 `activeTab`，却可以使用目标标签页仍有效的已有授权。

官方依据：[activeTab 的授予与能力](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[Tabs 权限](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions)。

## 已审核权限边界

[权限基线](../../config/permissions-baseline.json) 将每项权限及用途一起保存。`npm run check:permissions` 同时校验源码和构建 manifest，拒绝缺失、额外及重复权限，包括两类可选权限。新增能力应先说明产品需求、影响和理由，经审查修改基线；没有自动更新快照命令。两类图片域名用于图片下载，不是文章入口。

浏览器验证使用完整版 Chrome 加载 `dist/`，遵守 [验证命令约定](verification.md)。需要真实用户浏览器会话的任务，先核对可用浏览器入口与授权；本约定不安装 MCP、不修改全局配置。

## 本机技能定向修正

本项目实际加载来源：`.agents/skills/chrome-extensions/SKILL.md`（本轮完整路径 `/home/forclaw/code/WeTrim/.agents/skills/chrome-extensions/SKILL.md`）。该目录被 Git 忽略，没有可核实的上游提交标识；以补丁原文及 SHA-256 标识本次输入，而不声称修正所有安装版本。

版本控制中仅保存[定向补丁](patches/chrome-extensions-active-tab.patch)及[修改前后摘要](patches/chrome-extensions-active-tab.sha256.json)，未引入整个第三方技能。补丁涉及正文、检查清单及直接引用的权限、侧栏、标签页、捕获、Prompt API 说明；其他能力各自的权限要求保持不变。

技能更新或在新工作区安装后：

1. 定位本次实际加载目录，读取当前内容，对照摘要和补丁确认是否仍有同一问题。摘要不匹配时人工重审，不盲目覆盖。
2. 保存原文件或本补丁，从项目根目录使用 `git apply --check --directory=.agents/skills/chrome-extensions <补丁绝对路径>` 预检（技能目录须为相对路径）；有写入授权并通过宿主审批后再执行相同参数的 `git apply`。路径受保护时必须走审批入口。
3. 核对每个文件的修改后 SHA-256，并以以下场景检查建议；仅搜索关键词不算行为验收。写入证据记录在本次运行记录中，仓库提交不等于本机已应用。

| 固定场景 | 应有判断 |
| --- | --- |
| 用户在公众号文章页点击扩展图标，读取回调的 `tab.url` 并注入抓取脚本 | 有效的 `activeTab` 允许读取 URL，注入还需 `scripting`；不加 `tabs`，仍处理受限页面、缺失字段和导航导致失效 |
| 后台定时任务查询当前标签页，没有有效 action 授权，也没有适用主机权限或 `tabs` | 不能假设可读 URL 或可注入；请用户在目标文章页触发既定入口，不以“当前”代替授权、不自动扩大权限 |

若补丁无法应用或场景判断不成立，保留原文和冲突证据，重新审查定向修改。
