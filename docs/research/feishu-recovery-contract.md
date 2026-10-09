# 飞书恢复与可选权限验证：契约核查

核查日期：2026-10-07。本文只整理官方契约和实验判据；没有访问真实凭据、调用测试表 API 或修改扩展代码。沿用 [个人授权码契约](feishu-personal-token-contract.md) 与 [现场验证记录](feishu-live-validation.md)，不重新推定已经取得的实测结论。

## Chrome 可选主机权限

- API 主机应声明在 `optional_host_permissions`，实验可固定为 `https://base-api.feishu.cn/*`。声明只使其可以申请；`permissions.request({origins: [...]})` 必须发生在用户手势内。最稳妥的实验入口是扩展页面按钮的点击处理器，在任何异步预检查前发起申请。[Chrome permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions#implement_optional_permissions)
- `contains` 检查当前权限，`remove` 移除访问权；申请可能返回拒绝，调用问题可能导致 Promise 拒绝。授权、拒绝、移除后分别重查 `contains`，不要把“调用完成”当作已授权。[API 方法](https://developer.chrome.com/docs/extensions/reference/api/permissions#methods)
- `remove` 不清除历史 granted 集合；因此再次申请可能直接恢复，不弹第二次提示。这是正常契约，不能把“没弹框”当作失败，也不能把扩展自身的移除等同于用户在浏览器设置中撤销历史授权。[Chromium 权限存储](https://chromium.googlesource.com/chromium/src/+/HEAD/extensions/docs/permissions.md#differences)
- Chromium 将活动权限与已授予权限写入扩展 Preferences，加载扩展时据活动集合恢复权限。这支持同一浏览器配置、同一扩展身份下的跨重启持久预期；`activeTab` 则属于不同的临时权限类别。[Chromium 权限存储与非持久权限](https://chromium.googlesource.com/chromium/src/+/HEAD/extensions/docs/permissions.md#storing-permissions)

**实验判据（本次研究提出，尚未执行）：** 初次 `contains=false` → 用户点击并允许 → `contains=true` → 完整退出专用 Chrome 并用同一 profile/扩展身份重启 → 再查为 true → `remove` 后 false → 再次完整重启仍为 false。另设用户拒绝用例。仅关闭页面、终止 worker 或重载扩展，不算浏览器重启。不要通过直接改 Preferences 模拟授权，也不要用同时具备该域名必需权限的扩展测试可选权限移除。

## 个人 Base API 的字段与记录

个人令牌路线使用独立 Base API 域名，字段、记录路径遵循 Bitable v1；官方个人令牌 SDK 的相应方法明确使用 `AccessTokenTypePersonal`。这不是普通开放平台应用令牌的 scope 清单。[官方个人令牌 SDK Base 方法](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/api.go)

| 待验证对象 | 当前能确认的契约 | 实验不能预先假定的部分 |
| --- | --- | --- |
| 单选列与选项 | 类型 `3` 为单选；字段属性含 `options`；选项有 `name`、`id`、`color`，创建时不允许指定选项 ID。[字段模型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L1458) | 现有实测是多选标签，不自动证明单选未知选项、改名和删除后的行为；未找到可读取的当前官方正文保证“未知单选一定自动创建”。 |
| 字段身份 | 字段元数据同时有 `field_id`、`field_name`、`type`，字段更新端点通过 `field_id` 定位。[元数据模型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L1268)、[字段更新](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/api.go#L776) | 不能从字段更新路径推导记录 `fields` 对象直接接受字段 ID。当前 SDK 只声明字符串键映射，没有明确的 `field_key` 开关。[记录模型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L2114) |
| 记录查询 | 支持按 `record_id` 获取；列表支持 `filter`、`field_names`、分页游标，响应有 `has_more`。带 filter/sort 时忽略 view_id。[查询方法](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/api.go#L1064)、[列表参数](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L6585) | 单次未查到不保证远端没有写入；分页查询不是跨并发修改的一致性快照承诺，也不提供文章唯一约束。 |
| 创建去重线索 | 新增记录 SDK 暴露 UUID 格式 `client_token`，注释描述非空时幂等；业务成功判断为 `code == 0`。[创建参数与响应](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L6364) | 本次未获得个人 Base 路线的幂等保存时长、并发窗口、变更请求体行为保证；不能套用 Webhook 的三小时规则或声称永久 exactly-once。 |

**可执行的保守实验路径：** 保存字段 ID；每次恢复先读取当前字段定义，以 ID 定位当前名称并校验类型及所需单选选项，再按当前名称构造写入。分别测试改名、缺列、类型改变、选项缺失；直接以字段 ID 作记录键应作为独立探测，不当成已支持能力。查询用同一恢复标识完整分页、精确匹配；零条、唯一一条、多条分别记录，零条仍保留结果未知，不能据此无条件重建。

## 附件回执的有效性边界

`upload_all` 返回 `file_token`；附件模型另有 `url` 和 `tmp_url`，后者明确是临时下载 URL。上传回执与记录关联是两个操作，因此只有上传回执不能证明附件已进入记录。[上传响应](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/drive/v1/model.go#L4782)、[附件模型](https://github.com/larksuite/base-sdk-go/blob/30c28acc072f27dd885b1b08ff055d8b71799bca/service/base/v1/model.go#L2580)

已有现场记录证明：在该测试环境，上传后关联遭明确拒绝，可以复用同一回执完成关联并下载一致字节。它只证明当次恢复成立，不证明未关联素材永久保留，也不证明跨 Base、跨账号或权限撤销后可复用。[现场证据](feishu-live-validation.md)

本轮没有查得个人 Base 路线对“上传后长期未关联素材”的明确回收期限，不能给回执自行赋予永久有效期。恢复实验应分别记录上传、关联、回读及下载结果；已关联成功时优先查记录验证关联；尚未关联时尝试使用保存的 token，失败则保持可恢复失败状态。短期试验成功不能定义长期保留 SLA。

## 证据边界

Chrome 官方页面和 Chromium 权限实现说明已通过网页工具直接读取。飞书 [新增记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create)、[创建字段](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/create)、[数据结构](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bitable/development-guide/bitable-structure)、[上传素材](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all) 本轮网页提取为空，不能声称读到了其正文；上述 SDK 事实来自直接读取 `larksuite` 官方仓库固定提交的源码。SDK 声明不是当前服务端所有边界的保证。本文的实验建议是由这些契约推出的验证方案，不是实测结果。
