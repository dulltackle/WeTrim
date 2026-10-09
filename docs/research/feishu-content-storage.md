# 飞书文章正文、图片附件与标签：补充事实研究

核查日期：2026-10-06。服务于[确定文章正文、图片与标签的保存形式](https://github.com/dulltackle/WeTrim/issues/51)，补充[首次接入研究](feishu-bitable-integration.md)。本文只记录事实与待验证边界，不替用户决定连接路线，不实施功能。未使用真实凭据、调用写接口或改变权限。

用户已明确：正文用于查找、复制，保留完整 Markdown；图片保存副本到同一条飞书记录的附件区；首版不要求正文原位置显示图片。这些是产品取舍，不等于已经通过接口验收。

## 可以立即用于讨论的结论

- **中国版文本容量已有官方证据**：飞书帮助中心给出的文本单元格上限为 100,000 字；不能承诺无限长度。官方未解释这里的“字”按 UTF-16、Unicode 码点还是其他规则计数，故准确程序计数及 Bitable v1 边界响应仍待实测。[飞书多维表格常见上限](https://www.feishu.cn/hc/zh-CN/articles/485779748873)
- **一个附件字段不能无限装图片**：官方产品上限为每个附件单元格 100 个附件、单附件 2 GB、整张数据表 20,000 个附件。这里是单元格上限，不是声称一条记录的全部附件字段合计上限；若采用一个“图片”字段，单篇就受 100 个附件限制。[飞书多维表格常见上限](https://www.feishu.cn/hc/zh-CN/articles/485779748873)
- **图片副本需要上传实际文件并关联记录**：官方 SDK 支持素材上传类型 `bitable_image` / `bitable_file` 并返回 `file_token`；Bitable v1 记录字段接受带 `file_token` 的对象数组。只写原图片 URL 没有完成副本归档。[官方 SDK 素材上传](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/drive.ts#L3016)、[官方 SDK 新增记录](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1646)
- **此前纯 Webhook 配置结论需要重新评估**：官方 Webhook 触发器不能解析或传递图片、附件。由此推断，仅凭工作流 URL 与凭证不能直接满足本次图片附件要求；Open API 上传或另加具备上传能力的中间处理会引入新的连接、鉴权与运行前提。不能把用户选择图片附件自动解释为用户已同意哪一种鉴权方案。[官方 Webhook 触发器](https://www.feishu.cn/hc/zh-CN/articles/612376356355)

## 正文与附件的技术边界

正文选择可以表述为“在容量允许范围内保存完整 Markdown 文本，供检索和复制”。本研究没有证明 Markdown 会在文本字段渲染，也未验证富文本 API。超过正文容量时，是拒绝保存、另附完整 Markdown 文件，还是另选承载方式，属于仍需明确的产品决策；不能默认静默截断或拆成多条文章记录。

素材上传与产品附件容量是不同层次。官方 CLI 共享上传实现把单次上传阈值设为 `20 * 1024 * 1024` 字节，并提供分片上传流程；其附件命令在超过该阈值时改走分片。它还明确使用 `parent_type=bitable_file`，以目标 Base token 作为 `parent_node`，将返回的 `file_token` 附加到附件单元格。这个源码证据支持 20 MiB 阈值与上传关联路径，但不能据此声称 WeTrim 已支持 2 GB 文件或已验证中国版 v1 的全部分片规则。[官方 CLI 上传实现](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/common/drive_media_upload.go#L19)、[官方 CLI 附件命令](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/record_upload_attachment.go#L145)

推论：下载源图失败、附件数超限、上传失败、上传已成功但创建记录失败，都必须在后续保存语义中有明确结果；不能在缺图时仍无条件称为“完整归档”。是否接受部分成功、如何重试与恢复留给对应决策票。

## 多选标签：已证实读取结构，未证实未知标签直写行为

1. Bitable v1 的列出字段接口返回字段 `property.options`，选项包含 `name`、`id`、`color`，并提供分页参数。这足以支持研究“从目标表读取已有标签作为选择项”的路线。[官方 SDK 列出字段](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L10815)
2. Bitable v1 更新字段的输入同样含 `property.options`，其中 `name`、`id`、`color` 均为可选。官方注释明确更新为全量覆盖，`property` 等会被完全覆盖。因此若走字段更新来管理选项，必须先读取并保留现有配置，不能只提交新标签并推定是追加。此接口结构不单独证明“不带 id 即新增”的完整服务端规则。[官方 SDK 更新字段](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L10985)
3. 本轮仍未获得可读的一手证据确认 **v1 新增记录直接提交未知多选标签**究竟自动创建、拒绝还是受配置影响；也未验证重名、空白、大小写等匹配规则。不能套用 Base v3 官方 CLI 对已有选项的要求来替代 v1 契约。
4. 官方产品帮助说明单选或多选字段最多配置 10,000 个选项；这不是单条记录最多可选多少标签的证明。[飞书多维表格常见上限](https://www.feishu.cn/hc/zh-CN/articles/485779748873)

## 个人固定表格的鉴权前置条件

即便只写个人固定表，Open API 仍要满足有效调用身份与目标资源编辑权限。官方 v1 新增记录和更新字段注释都要求 `tenant_access_token` 或 `user_access_token` 身份已有多维表格编辑等文档权限；表格 URL、`app_token`、`table_id` 只是定位资源，不代替鉴权。[官方 SDK 新增记录权限](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1654)

自建应用路线依赖 App ID、App Secret 获取有有效期的访问令牌；官方 SDK 依据 `expire` 缓存和提前更新。因而最少还要解决应用可用性、API 权限、目标表资源授权、凭据保存与令牌续期。个人固定表可以缩小目标范围，不能免除这些步骤。[官方 SDK 令牌管理](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/client/token-manager.ts#L125)

**仍未证实最小 scope 字符串集合**：官方 CLI 附件组合动作声明 `base:record:update`、`base:field:read`、`docs:document.media:upload`，但记录侧属于 Base v3；不可把它当作 Bitable v1 最小权限清单，也不能默认用更宽权限替代核实。尚未验证目标个人账号能否创建所需应用、是否需管理员审批以及纯扩展运行环境的凭据方案。[官方 CLI scope 声明](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/record_upload_attachment.go#L42)

## 实施前应补的验证

- 对中国版目标 Bitable v1 测试文本边界：ASCII、中文、emoji、换行，等于和超过文档上限；回读确认没有截断。
- 在测试表上传一张图片、写入同一条文章记录并下载核对；验证附件容量、分片边界与部分失败，不把平台产品上限直接作为首版支持承诺。
- 读取现有多选配置；分别提交已存在和全新标签并回读；若采用更新字段新增选项，验证完整保留旧选项及并发行为。
- 固定接口版本后逐项确认记录创建、字段读取、素材上传，以及必要时字段更新的 scope；对目标表单独授予资源权限并验证。

## 核查方法与证据限度

本轮已通过 web 浏览打开官方 API 页面，但新增记录、字段与素材 API 页多数只返回标题，未据此伪称已读到完整接口契约。中国版帮助页的正文从公开 HTML 内 `answer_txt` 等内容读取，并与同一 Feishu 帮助中心英文页交叉核对；并非沿用 Lark 国际版数值。SDK 和 CLI 均引用官方 `larksuite` 仓库固定提交。未采信第三方镜像来填补 v1 未知行为。
