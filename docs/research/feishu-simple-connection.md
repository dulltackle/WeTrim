# 飞书连接配置简化：官方工具引导授权

> **2026-10-06 后续核查更正**：下文保留此前调查记录，但“优先讨论安装官方工具”的建议已被新证据替代。飞书多维表格确有 `personalBaseToken` 授权路线，官方 SDK 同时提供记录操作和真实附件上传。应优先验证“表格链接 + 授权码”的配置方式，而不是先要求用户创建自建应用或安装工具。详见本文末尾补充。

核查日期：2026-10-06。服务于[选择飞书连接方式与配置边界](https://github.com/dulltackle/WeTrim/issues/50)，不替用户作出选择，不实施集成。未使用真实凭据，未安装工具、创建应用或修改权限。

## 可以向用户提出的方案

**有减少手工配置的官方路径：在本机安装飞书官方工具，通过它打开网页完成应用配置和用户授权。** 官方 `larksuite/cli` 明确提供“一键创建应用”与交互登录；快速开始依次执行安装、`config init --new`、`auth login`。初始化会输出授权链接，用户完成网页操作后结束。[官方中文说明](https://github.com/larksuite/cli/blob/main/README.zh.md)、[官方配置流程](https://github.com/larksuite/cli/blob/main/skills/lark-shared/references/lark-shared-config-init.md)

这条路仍然有应用身份，只是减少用户手动查找、复制应用配置的工作。官方设备授权源码仍使用应用编号和应用密钥请求授权及换取令牌，不是个人访问令牌替代应用。[官方设备授权源码](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)

## 对 WeTrim 的实际取舍

| 路线 | 用户配置成本 | 尚未解决的事 |
| --- | --- | --- |
| 官方本地工具引导 | 安装本机工具，打开网页完成配置与授权，再指定目标表 | 需要设计并验证 WeTrim 与本机工具的连接；不能把命令行的成功路径直接当成扩展现成功能 |
| 自己创建应用、填配置 | 手动创建应用、开通所需权限、配置目标表访问，再填应用信息 | 保持纯扩展直连的候选路线，仍须验证附件和令牌管理 |
| 纯扩展内“登录飞书” | 理想体验最少 | 本轮没有证明无需本机工具、无需开发者应用、无需服务端即可完整实现；只能列待验证方向 |

第一条的安装与登录流程没有要求用户部署公网服务器。该事实不等于 WeTrim 接入已完成；本机通信、最小权限、目标表授权与真实附件写入仍需验证。官方 CLI 同时面向飞书和 Lark，本轮依据其双品牌官方说明，没有将国际版独有权益推广到中国飞书。[官方仓库](https://github.com/larksuite/cli)

## 不应提前承诺的替代方案

- **个人访问令牌（PAT）**：本轮未找到足以证明飞书中国版可以用个人 PAT 完整替代应用配置、上传素材及写多维表格的一手资料。不能断言不存在，也不能建议用户去创建一个尚未核实的入口。
- **Webhook 加链接转附件**：飞书官方确认存在第三方字段捷径生态，但这不足以证明有免费、原生、任意来源图片都能成功的“链接转附件”能力。需要按具体提供者、收费、外链访问条件和实际副本结果验证。[飞书字段捷径介绍](https://www.feishu.cn/content/base)
- **扣子字段捷径**：扣子官方支持附件型输出，要求回复含 Markdown 文件链接。这是另一个产品的集成路径，不能由此推出更简单、无额外配置或无费用，也未验证微信公众号图片的实际获取结果。[扣子官方发布说明](https://docs.coze.cn/guides_shortcut)

## 建议继续讨论的唯一问题

是否接受“电脑多安装一个官方工具，以减少飞书后台手工配置”？这是用户体验与安装边界的选择。若接受，下一步才验证本机连接与附件上传；若坚持只安装浏览器扩展，则继续调查纯扩展授权，不应立即宣称只能手动创建应用。

## 后续核查：可以填写多维表格个人授权码

用户追问“确定不可以通过填写 token 之类的形式授权吗”后，查到以下一手证据：

- 飞书官方 `larksuite/base-sdk-go` 使用 `NewClient(personalBaseToken, appToken)` 创建客户端，默认请求域名是中国飞书的 `https://base-api.feishu.cn`，并另列 Lark 域名。这不是只适用于国际版的推测。[官方 Go SDK 说明](https://github.com/larksuite/base-sdk-go#readme)
- 同一官方说明包含“附件上传”，使用上述客户端调用 `Drive.Media.UploadAll`，上传本地 `demo.jpeg` 文件。因此个人授权码路线并不局限于文字或图片外链。[官方附件上传示例](https://github.com/larksuite/base-sdk-go#附件上传)
- `@lark-base-open/node-sdk` 说明将 `personalBaseToken` 定义为从网页端获取的 Base 个人鉴权令牌，默认 `Domain.Feishu`；文件上传示例明确使用 `parent_type: bitable_image` 或 `bitable_file`、`parent_node: client.appToken`，返回 `file_token`。该包也是 Base 团队 MCP 项目采用的 SDK。[SDK 发布说明](https://www.npmjs.com/package/@lark-base-open/node-sdk)、[Base 团队 MCP 项目](https://github.com/Lark-Base-Team/lark-base-mcp-node-server#readme)
- Base 团队项目将获取入口写为多维表格的插件界面 → 自定义插件 → 获取授权码（`Custom Plugin -> Get Authorization Code`），使用 `appToken` 和 `personalBaseToken` 读写飞书多维表格。[授权码入口说明](https://github.com/Lark-Base-Team/lark-base-mcp-node-server#tokens)

因此，WeTrim 的候选配置可以简化为：打开目标多维表格，获取个人授权码，在 WeTrim 填入授权码及目标表格链接。`appToken` 是 Base 的标识，不是要用户创建的开放平台应用密钥；数据表还需 `table_id`。扩展可以解析可支持的表格链接来减少手工填写，但知识库链接等形式仍需验证。

需要明确区分：这里说的是 **`personalBaseToken`**；不是让用户复制通常需要续期的 `tenant_access_token` / `user_access_token`，也不是把 URL 中的 `app_token` 本身当作授权凭据。

尚未实测的边界：用户所在租户当前是否显示该入口、生成者权限要求、授权码有效期与撤销规则，以及扩展端直连和“上传图片 → 将 `file_token` 写入附件字段”的完整保存流程。现有官方源码足以证明该路线存在；不足以承诺 WeTrim 已支持，也不足以宣称令牌永久有效。未使用真实凭据，未安装软件，未更改权限。
