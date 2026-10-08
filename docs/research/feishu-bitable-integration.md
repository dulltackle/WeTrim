# 飞书多维表格接入：鉴权与内容能力研究

核查日期：2026-10-06。对应研究票：[核实飞书多维表格写入鉴权与内容限制](https://github.com/dulltackle/WeTrim/issues/49)。本文服务于后续产品决策，不选择接入路线，不实施功能。未使用真实凭据调用接口，未创建飞书资源或修改权限。

## 用户已确认的边界

每篇文章的清洗结果保存为一条文章记录，同一张表积累多篇文章；用户保存时手动选择或输入多个文章标签；标题、标签筛选使用飞书已有功能。文章记录不是可恢复编辑进度的清洗会话。沿用 [GLOSSARY.md](../../GLOSSARY.md)；现有按块转换、合成清洗结果的边界见 [ADR-0007](../adr/0007-per-block-conversion.md)。鉴权路线、正文形式和图片保存方式仍待用户决定。

## 研究结论与可决策范围

**可以继续讨论连接方式与内容形式，但不能把尚未验证的条件当成现成功能承诺。** Webhook 地址加凭证是官方支持的轻配置路线；它需要先在飞书配置并启用工作流，且返回的是接收状态。Open API 有记录回执和素材上传接口，但需要应用或用户身份、目标资源权限、访问令牌管理。二者差异已有一手证据；正文精确上限、Webhook 多选映射、未知标签创建行为和接口版本的最小 scope 仍需按下文门槛验证。

## Webhook：轻配置所依赖的飞书侧准备

飞书中国版多维表格支持以收到 Webhook 为工作流触发条件。每个流程有唯一地址，后续可配置新增记录并引用请求字段。Bearer token 校验可开启、复制、重置；重置后须保存并启用才生效。开启 IP 白名单还会限制调用来源。因而“URL + token”指的是**工作流地址与工作流凭证**，不是表格 URL 中的 `app_token`。[官方触发器说明](https://www.feishu.cn/hc/zh-CN/articles/612376356355)

该路线至少要求用户或模板配置者完成：创建可写目标表及所需字段；建立 Webhook 输出 schema；把标题、正文、标签、来源链接映射到新增记录操作；保存并启用流程；把地址和凭证交给扩展。修改输出 schema 会使既有引用失效；复制流程会重新生成地址和已开启的凭证。因此扩展设置简单不等于飞书侧零配置。[官方触发器说明](https://www.feishu.cn/hc/zh-CN/articles/612376356355)

请求使用 POST 和 JSON；开启校验时发送 `Authorization: Bearer <token>`。官方参数页允许 `Client-Token`：相同非空值在 3 小时内只触发一次，空值视为新请求。这是短时重复触发保护，不是永久按文章去重，也不证明失败节点会自动重跑。[官方 Webhook 参数](https://www.feishu.cn/hc/zh-CN/articles/383585269199)

**成功含义必须分开。** 官方把 `{"code":0,"data":{},"msg":""}` 描述为 Webhook 接收正常，非零 `code` 为失败；示例没有记录 ID。因此即使 HTTP 成功，也必须检查业务 `code`；`code=0` 只能依据现有契约呈现为已接收，不能直接宣称文章已落库。若产品要求最终保存确认，需另行设计观察工作流运行结果、回查记录或回调；本研究未证明 Webhook 本身同步返回后续新增记录的结果。[官方 Webhook 参数](https://www.feishu.cn/hc/zh-CN/articles/383585269199)

触发器仅接收文本类数据，不支持解析或传递图片、附件；请求体上限 4 MB。整个多维表格 50 次/秒，单流程 5 次/秒，未启用凭证校验的流程 1 次/秒。这些不是正文单元格容量；传图片 URL 字符串也不等于上传图片附件。[官方触发器说明](https://www.feishu.cn/hc/zh-CN/articles/612376356355)

## Open API：资源标识、访问身份与回执

官方 Node SDK 的 Bitable v1 新增记录接口使用路径 `POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records`，并另行处理请求 headers。`app_token` 与 `table_id` 定位目标资源，不独立授权写入；接口注释明确，调用身份为 `tenant_access_token` 或 `user_access_token`，且必须已有目标多维表格的编辑等文档权限。来源同步表不支持增删改。[官方 SDK：新增记录](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1646)

自建应用凭 App ID、App Secret 调用 `/open-apis/auth/v3/tenant_access_token/internal` 获取 `tenant_access_token` 和 `expire`；官方 SDK 按 `expire` 缓存并提前刷新。它不是让用户长期粘贴后永不更新的固定 token。应用 API 权限与目标文档的资源权限要分别满足。用户访问令牌是另一种调用身份，不应与表格标识或 Webhook 凭证互换。[官方 SDK：令牌管理](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/client/token-manager.ts#L125)、[官方 SDK：新增记录权限前提](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1654)

新增记录响应类型包含业务 `code`、`msg`、`data.record.record_id`，以及 `record_url` 等记录信息。这提供比 Webhook 接收回执更直接的记录确认依据。实现应检查业务成功并保存记录 ID；超时或断网不能直接推定没写入，重试/去重策略仍需决定。SDK 暴露 `client_token` 参数，但这里不把 Webhook 的 3 小时规则套用于它。[官方 SDK：请求与响应结构](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1699)

### 最小权限与接口版本的证据边界

目标资源层面已证实需要目标表编辑权限；不需要从本研究推导出对全租户文档开放权限。具体 API scope 不能只凭旧教程中的宽泛 `bitable:app` 就断定为最小集合：当前官方 CLI 的记录批量新增声明 `base:record:create`，但它调用的是 **Base v3**，不是上述 Bitable v1。[官方 CLI scope](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/record_batch_create.go#L12)、[官方 CLI 路径](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/record_ops.go#L319)

实施前应先固定中国版租户可用的接口版本，再在开放平台该接口的权限页和测试应用验证：仅新增记录的 scope；若读取标签选项，追加字段读取能力；若上传素材，追加素材上传能力；只有确需补写已有记录时再追加更新能力。不要直接把 v3 scope、v1 字段格式和不同教程的权限合并成“大而全”授权。

## 正文、图片与多个标签

| 项目 | 已有一手证据 | 仍需验证及对决策的影响 |
| --- | --- | --- |
| 正文文本 | Bitable v1 `fields` 接受字符串；Webhook 请求体不得超过 4 MB。[SDK](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1657)、[触发器](https://www.feishu.cn/hc/zh-CN/articles/612376356355) | 未取得飞书中国版文本单元格准确上限及计数单位的可读一手正文。不可承诺无限正文、不可把 4 MB 当单元格上限。 |
| “10 万字”线索 | Lark 国际版官方帮助明确单元格文本不超过 100,000 字。[Lark 上限](https://www.larksuite.com/hc/zh-CN/articles/890398616778) | 本轮未找到等价中国版页面；不能无条件推广到飞书中国版或断定 UTF-16/码点计数。应在目标接口核实边界。 |
| 图片附件 | 官方 SDK 素材上传支持 `bitable_image`、`bitable_file`、`parent_node`、文件内容，返回 `file_token`；新增记录字段接受带 `file_token` 的对象数组。[素材上传](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/drive.ts#L3016)、[记录字段](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/code-gen/projects/bitable.ts#L1686) | Open API 有上传素材后关联记录的能力；仍需核实选定版本的素材权限、大小/数量限制及失败补偿。附件单元格存在不等于正文原位置嵌图或 Markdown 富文本渲染。 |
| 多个标签 | 当前官方 CLI 的 Base v3 文档给出 `"标签": ["高优", "外部依赖"]`，并要求选项已存在。[官方 CLI 字段说明](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/skills/lark-base/SKILL.md#L151) | 可确认有多选数组模型，但不能把 v3 文档当成 v1 或 Webhook 的自动新增选项契约。用户“输入新标签”若意味着新增选项，需要另行验证或明确创建选项步骤。 |
| Webhook 标签映射 | 输出 schema 可供后续节点引用；新增记录是支持的操作。[触发器](https://www.feishu.cn/hc/zh-CN/articles/612376356355) | 尚未验证字符串数组到多选单元格是否直接映射、未知值会创建还是拒绝。不得退化为逗号拼接文本却仍声称支持原生多选筛选。 |

官方 CLI 还包含上传附件再把返回 `file_token` 追加到记录附件单元格的完整路径，声明 `base:record:update`、`base:field:read`、`docs:document.media:upload`。这是该 CLI 组合动作的权限集合，不能直接称为所有实现的最小权限。[官方 CLI 附件实现](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/shortcuts/base/record_upload_attachment.go#L42)

## 实施前的明确验收门槛

以下为证据不足处的验证计划，不是已通过的测试，也不要求本轮获取真实凭据。

1. **鉴权与最小权限**：固定选用 API 版本和身份；从仅新增记录所需 scope 开始，目标资源只授予测试表编辑权限。验证可新增、不可操作未授权表，分别记录缺 scope 与缺资源权限的结果。额外的字段读取、素材上传、更新逐项加入并说明用途。Webhook 路线另测正确/错误凭证、禁用流程与 token 重置。
2. **正文边界**：先核实中国版目标接口文档；再在测试表以普通中文、ASCII、emoji、换行，覆盖文档上限前一位、等于上限、后一位并回读比对，排除截断；另测 JSON 编码后的请求字节数。若无法保留整篇，回到产品票决定拒绝、附件/文档承载等策略，不默认拆成多条文章记录或静默截断。
3. **原生多选**：预建两个标签，分别写入一个、多个、空数组、带逗号的单个名称、一个全新标签；读回并在飞书筛选。分别测选定 API 和 Webhook 映射。若新标签不会创建，确定由谁创建选项以及是否需要额外权限，再承诺自由输入。
4. **保存确认与重试**：记录 Webhook HTTP/业务回执、流程运行日志及最终行；制造字段映射错误观察接收成功后的失败。验证相同 Client-Token 重复请求只有一次触发。Open API 保存 `record_id`，模拟回包丢失后验证重试不会无意重复；不要以 HTTP 200 作为唯一成功条件。
5. **图片**：上传一张实际图片后写入同一条文章记录，验证可浏览、下载、权限与保留的正文顺序表达。测上传成功而记录失败；不会把外链文本、上传素材、记录附件、正文内嵌图视作同一结果。
6. **运行环境**：在实际扩展上下文验证跨源请求、域名权限、令牌存储及撤销；核对用户租户可用工作流功能、次数额度及管理员限制。本轮未承诺免费额度或创建应用的权限。任何权限变化遵守[扩展工具与权限约定](../agents/extension-tools.md)，保留 [ADR-0006](../adr/0006-single-entry-from-article-tab.md) 的文章入口边界。

## 后续产品票可以讨论什么

连接方式票可比较“扩展填地址/凭证、飞书预先配工作流、接收与落库分离”与“应用/用户授权、管理访问令牌、直接获得记录回执”的配置和反馈成本。内容形式票可比较文本、图片外链、真实附件等不同保留程度；不能先承诺正文原样渲染或无限长度。

研究足以解除这两项**产品讨论**的前置阻塞；若后续决策把精确字数上限、任意新标签直写或同步最终成功视为必要条件，则必须先完成对应门槛，不能把未知项作为默认肯定答案。本文没有决定选择 Webhook 或 Open API，也没有替用户决定放弃图片。

## 来源与核查方法

仅将官方帮助中心及 `larksuite` 官方源码作为事实依据；API 文档的[新增记录页](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create)与[自建应用令牌页](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)本轮网页提取只返回标题，因此没有把空白页当成完整验证。帮助中心参数页通过公开 HTML 内正文读取；源码引用固定到核查时提交。官方 CLI 的 v3 线索和 Lark 国际版上限均明确标注适用边界。没有采用社区教程或第三方镜像来替代待确认的中国版契约。
