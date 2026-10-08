# 飞书个人授权码分片上传补充核查

日期：2026-10-07（America/Los_Angeles）。本研究仅读取公开官方源码、已有研究记录；未读取 `.env`、使用真实凭据或修改外部系统。真实接口结果由主代理独立执行，下文单独标注。

## 支持结论

仍未发现个人授权码分片上传的明确官方支持证据。GitHub API 本轮确认 `larksuite/base-sdk-go` 的 `main` 仍为 `30c28acc072f27dd885b1b08ff055d8b71799bca`，其 Drive 方法仅有 `Download` 和 `UploadAll`，两者声明 `AccessTokenTypePersonal`。缺少分片实现不能单独证明服务端不支持。[个人授权码 SDK](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/api.go)

通用开放平台 SDK `larksuite/oapi-sdk-go` 的 `v3_main` 本轮固定为 `99927aa13e271ea9fe03591204aad7bc6a2d869c`，实现三阶段素材上传，但三个方法声明的令牌类型均为 `User`、`Tenant`；它们不是个人授权码支持声明。既有官方指南核查只列个人路线的上传素材和下载素材，结论保持不变。[通用 SDK](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/resource.go#L1243)、[此前指南核查](feishu-personal-token-contract.md)

## 已核实的通用接口契约

以下是官方源码的路径与参数，不能直接视为 `base-api.feishu.cn` 的服务能力承诺。

| 阶段 | 方法及路径 | 请求模型 | 成功数据 |
| --- | --- | --- | --- |
| 预上传 | `POST /open-apis/drive/v1/medias/upload_prepare` | `file_name`、`parent_type`、`size`（字节）、`parent_node`、`extra` | `upload_id`、`block_size`、`block_num` |
| 上传分片 | `POST /open-apis/drive/v1/medias/upload_part`，SDK 设置文件上传选项 | `upload_id`、`seq`（从 0 起）、`size`（当前块字节数）、`checksum`（Adler-32 字符串）、`file`（分片二进制） | 通过业务码判断；模型无独立数据结构 |
| 完成上传 | `POST /open-apis/drive/v1/medias/upload_finish` | `upload_id`、`block_num` | `file_token` |

路径来源：[预上传](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/resource.go#L1298)、[分片](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/resource.go#L1271)、[完成](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/resource.go#L1243)。参数来源：[MediaUploadInfo](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/model.go#L6961)、[分片请求](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/model.go#L14431)、[完成请求与回执](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/model.go#L14205)、[预上传回执](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/model.go#L14489)。

模型不表达完整必填约束；指针与 `omitempty` 不能证明服务端允许缺省。`parent_node` 注释明确它是上传目标云文档 token，`parent_type=ccm_import_open` 时不需要；`extra` 是特定上传点的扩展路由参数。预上传源码注释提到 4MB 分片，但实施应服从本次响应的 `block_size` 与 `block_num`，不能硬编码替代实际协商结果。[模型及注释](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/model.go#L6961)、[预上传说明](https://github.com/larksuite/oapi-sdk-go/blob/99927aa13e271ea9fe03591204aad7bc6a2d869c/service/drive/v1/resource.go#L1291)

本轮网页工具无法读取开放平台分片文档正文，故没有将网页抽取失败、搜索摘要或第三方内容当作新增契约证据。

## 本轮实测的独立证据

主代理报告：在既有授权范围内，同一原测试表凭据读取 Base 为 HTTP 200、业务码 0；向个人路线主机的上述 `upload_prepare` 路径发送小图片参数，返回 HTTP 404、非 JSON。没有取得分片会话，未调用后续分片或完成接口。脱敏报告为 `artifacts/feishu-validation/multipart-prepare-result-20261007T080258694389Z.json`（本地忽略目录）。此结果可表述为**本次环境下，已知通用分片预上传路径在个人路线主机不可用**；不能扩推到所有未来接口，也不能声称另外两个阶段已单独实测。

据此，当前规划仍应以已验证的 `upload_all` 能力和 20 MiB 边界为依据，不依赖个人授权码分片来处理超限图片。超过边界时采用何种产品行为，属于后续决策，不由本研究代替。
