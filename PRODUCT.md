# WeTrim 产品事实

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

正式扩展已确定为 Vite + TypeScript + React，Chrome / Edge 共用 MV3 包。本次清洗交互原型由开发者选择直接制作可点击界面，使用独立静态 HTML，只用于决策。

## Users

不懂技术、希望手动清洗微信公众号文章的用户。

## Product Purpose

按阅读顺序通读文章，逐块选择保留或剔除，必要时编辑内容，检查后导出 Markdown 和图片。按顺序通读的使用习惯已由开发者在本次原型讨论中确认。

## Operating Context

在文章页面点击扩展图标后，进入独立的扩展全页标签页。一次只清洗一篇文章，自动保存当前清洗会话并支持恢复。

## Capabilities and Constraints

- 内容块、图片引用、还原内容等术语以根目录 CONTEXT.md 为准。
- 列表、引用和表格整体成块；块内图片通过编辑 Markdown 取舍。
- 还原内容不改变保留或剔除；编辑不重新切块。
- 导出到每次选择的父目录下新建的文章目录。图片失败时默认暂停，用户可明确选择保留外链继续。
- 恢复编辑和取舍，图片重新获取；不承诺离线图片缓存。
- 不做历史文章库、批量抓取、拖拽排序或 Firefox 支持。
- 清洗界面的导航、状态表达和异常流程已经过原型讨论确认；完整结论见[清洗界面交互决策](https://github.com/dulltackle/WeTrim/issues/9)，原型资产归档于 `codex/prototype-cleaning-ui` 分支。
- 长文按公众号平台上界量级（约 2 万字、300 块）设计，连续渲染不做虚拟列表，不设数量硬上限；超过 1000 块只提示不拒绝。完整性能契约见[长文性能决策](https://github.com/dulltackle/WeTrim/issues/11#issuecomment-5595575026)。

## Brand Commitments

名称 WeTrim。面向开发者与当前原型的文案使用中文。

## Evidence on Hand

规范来源为[浏览器扩展决策地图](https://github.com/dulltackle/WeTrim/issues/1)及其已解决的决策票。当前 mvp.md 仍是待重写的旧方案，不能作为已确定架构依据。原型使用明确标记的合成文章与模拟状态。性能目标出自一次可丢弃探针的**合成文章**实测，`chrome.storage.local` 写入与搜索筛选均未实测；真实长文样例待[收集任务](https://github.com/dulltackle/WeTrim/issues/12)补齐后才谈得上验收。
