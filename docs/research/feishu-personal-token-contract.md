# 飞书多维表格个人授权码契约核查

核查日期：2026-10-06。范围仅为公开官方文档和官方源码；没有使用真实凭据，没有发起 Base/Drive 业务请求，没有安装插件，没有改动权限。因此本文的“支持”指文档或 SDK 声明，不等于 WeTrim 已实现或实测通过。此前 [连接方式调查](feishu-simple-connection.md) 保留为历史背景。

## 结论

`personalBaseToken` 是确实存在的中国飞书多维表格鉴权路线。官方 SDK 使用 `personalBaseToken` 与目标 Base 的 `appToken` 创建客户端，默认域名为 `https://base-api.feishu.cn`；后者是资源标识，不是开放平台应用密钥。[官方 SDK 说明](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/README.md)、[客户端定义](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/client.go#L83)

上传素材和下载素材有直接源码证据；**分片上传尚无个人授权码路线的充分支持证据**，不能因为通用 Drive 文档存在分片 API，就把它列为这一鉴权路线的已确认能力。[官方 Drive 实现](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/api.go)

## 证据口径

- 官方指南：[多维表格插件开发指南](https://feishu.feishu.cn/docx/S1pMdbckEooVlhx53ZMcGGnMnKc)。本轮协作主代理通过浏览器阅读“使用授权码”段落；研究子代理的网页抽取工具未能读取该页。下文注明来自该浏览器核对的内容，不使用第三方转载替代原文。
- 官方源码：[larksuite/base-sdk-go](https://github.com/larksuite/base-sdk-go)。本轮通过 GitHub API 固定 `main` 为 `30c28acc072f27dd885b1b08ff055d8b71799bca`，源码链接均固定到此提交。SDK 只能说明该版本实现，不能代表所有当前服务端能力。
- 飞书开放平台的 [上传素材](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/media/upload_all) 和 [分片上传概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/media/multipart-upload-media/introduction) 页面本轮抽取为空。因此接口细节以可读 SDK 源码为证据，不声称已阅读这些网页正文。

## 生成权限、作用范围与生命周期

本轮协作主代理已通过浏览器直接读取官方指南“鉴权”正文（非页面 AI 摘要），核实以下契约：

| 项目 | 官方指南明确说明 |
| --- | --- |
| 谁可以获取 | 目标多维表格的所有者、管理员 |
| 操作权限 | 可读写对应多维表格，服务端接口权限范围与授权码生成者一致 |
| 资源范围 | 仅操作对应多维表格；每个 Base 独立生成、独立使用，互不影响 |
| 有效期 | 默认永久有效 |
| 关闭与更新 | 可在多维表格网页端手动关闭或更新，构成上述永久有效的例外 |

来源：[官方指南“鉴权”](https://feishu.feishu.cn/docx/S1pMdbckEooVlhx53ZMcGGnMnKc#doxcnDn77unQkzvbk5cxq3Ultkf)。这些结论来自官方正文的浏览器核验；研究子代理未独立抽取该正文。本轮没有执行关闭或更新，故不声称已实测旧码失效、失效时延或错误返回。默认永久有效也不意味着生成者失去权限后仍可继续访问。

## Base 接口与素材能力

官方指南“使用授权码”说明：Base OpenAPI 在 `base-api.feishu.cn` 独立部署，接口路径和定义与飞书开放平台一致；列出的范围为多维表格 Base 的全部接口，以及 Drive 的“上传素材”“下载素材”两个接口。这里的“全部”仍受授权码资源范围和生成者权限约束，不能推导为任意文档、任意身份都可调用。[官方指南](https://feishu.feishu.cn/docx/S1pMdbckEooVlhx53ZMcGGnMnKc)

| 能力 | 官方源码证据 | 可作出的结论 |
| --- | --- | --- |
| Base 数据表、字段、记录操作 | `service/base/v1/api.go` 包含相应方法，路径为 `/open-apis/bitable/v1/apps/:app_token/...`，支持个人令牌类型 | 与目标 Base 相关的读写具有 SDK 契约；具体请求仍需满足权限和字段约束 |
| 上传素材 | `POST /open-apis/drive/v1/medias/upload_all`，明确 `AccessTokenTypePersonal` | 可用个人令牌上传二进制素材，返回 `file_token` |
| 下载素材 | `GET /open-apis/drive/v1/medias/:file_token/download`，明确 `AccessTokenTypePersonal` | 可用个人令牌请求素材下载，需满足素材权限 |
| 分片上传 | 当前 Drive 服务仅实现 `Download`、`UploadAll`；没有 `UploadPrepare`、`UploadPart`、`UploadFinish` 方法 | 当前 SDK 未封装该能力；服务端接受个人令牌与否仍未知 |

来源：[Base API 源码](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/api.go)、[Drive API 源码](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/api.go)、[上传请求与响应类型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/model.go#L4758)。

请求翻译器直接把个人令牌写入 `Authorization: Bearer …`，不通过应用密钥换取 `tenant_access_token`。`upload_all` 的请求体包含 `file_name`、`parent_type`、`parent_node`、`size`、可选校验与扩展信息、二进制文件；上传点类型包含 `bitable_image` 和 `bitable_file`。这是“上传实际文件”的证据，不能把上传成功本身当作附件单元格已写入成功。[鉴权实现](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/core/reqtranslator.go#L107)、[上传类型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/model.go#L280)

官方 README 的下载示例还说明：附件开启高级权限时，需要设置 `extra`，其中包含 `bitablePerm.tableId` 和按字段 ID、记录 ID 组织的附件 token 映射。因此只保存 `file_token` 未必足以覆盖全部下载权限情形。[下载示例](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/README.md#附件下载)

## 分片上传与大小限制应如何表述

SDK 对 `UploadAll` 的注释明确要求不要上传大于 20MB 的文件，并链接通用分片接口；同文件给上传、下载各标注 5 QPS，下载标注支持 Range。这些是源码注释中的限制，应作为设计参考，并在集成时核对当前服务端行为。[Drive API 注释](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/api.go#L38)

不能将上述分片链接视作明确授权支持：官方指南的 Drive 范围仅列两个接口，SDK 的实际方法也只有两个。`model.go` 中虽有 `UploadPrepareMedia` 上传点枚举，而 `DriveService.Media` 字段甚至保留“分片上传”注释，这些类型和标签均没有对应调用实现，不能证明服务端支持。[模型枚举](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/model.go#L295)、[DriveService 定义](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/api.go#L28)

因此适合 WeTrim 的当前规划口径是：先围绕单次上传路线设计大小约束；超过该约束的处理不能默认依靠个人授权码分片。此处也不能反向宣称分片必然不可用，尚需明确官方说明或经授权的真实接口验证。

## 未解决事项

- 主代理已在当前用户租户观察到授权码入口，见[现场验证记录](feishu-live-validation.md)；租户管理策略是否可另行限制，仍未核实。
- 生成者离职、账号停用、权限降低、Base 转移或删除时，授权码如何变化；是否存在明确失效时延和错误码契约。
- 分片三个阶段是否接受个人授权码；SDK 缺少封装并不是服务端拒绝的实测证据。
- 从扩展后台直接访问该域名、上传实际图片，再将返回的 `file_token` 写入附件字段并回读的完整流程。
- `upload_all` 20MB 注释对应的精确字节边界、当前限流及租户容量限制；没有实际请求结果，不能用注释替代边界测试。

以上是公开契约研究的边界。真实测试授权及执行进度以[现场验证记录](feishu-live-validation.md)为准，本研究子任务没有使用真实凭据。
