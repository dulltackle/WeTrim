# 调研：会话持久化的容量、完成与生命周期边界

核查日期：2026-09-08。服务于[决策：持久化模型与会话生命周期](https://github.com/dulltackle/WeTrim/issues/7)。本文记录平台事实和实施建议，不替代该票中的产品决策。外部事实仅使用 Chrome 官方资料。

## 容量与权限事实

- `chrome.storage.local.QUOTA_BYTES` 当前为 **10,485,760 字节（10 MiB）**，按各值的 JSON 序列化结果和键长度计量；超额写入失败，Promise 拒绝或回调中出现 `runtime.lastError`。有 `unlimitedStorage` 时忽略这一配额。Chrome 113 及以前默认限制为 5 MB。[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage#property-local)
- 官方权限清单没有给 `storage`、`unlimitedStorage` 列出安装警告。`unlimitedStorage` 也覆盖 IndexedDB、Cache Storage、OPFS；不能把此前研究中的“只对 local 有效”推广到所有存储 API。[权限清单](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- `storage.session` 是内存存储，浏览器重启、扩展停用、重载或更新会清空；其 10 MB 配额没有列出 `unlimitedStorage` 豁免。因此它适合辅助协调，不适合保存跨重启的文章进度。`storage.local` 卸载扩展时会被清除。[存储区域](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas)
- `unlimitedStorage` 解除配额和驱逐限制，不构成写入必定成功的承诺。[存储与 Cookie](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies#storage) 官方历史存储说明明确指出，无限存储仍受可用磁盘空间限制；这里只援引这一物理边界，不把旧 Chrome Apps 文档中的历史 API 配额当作当前 MV3 规则。[无限存储说明](https://developer.chrome.com/docs/apps/offline_storage/#unlimited-storage)

## “已保存”与页面关闭

**事实**：`StorageArea.set()` 的 Promise 在成功时兑现、失败时拒绝；调用函数本身不代表保存成功。当前 API 文档未给出断电后绝不丢失、操作系统刷盘完成或跨多次调用事务的保证，不能从 Promise 成功推导出这些额外承诺。[StorageArea.set](https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea/#method-set)

**事实**：Chrome 不建议依赖 `unload` 保存数据；页面终止事件并非可靠通知，进入冻结或终止状态后异步任务也不能可靠运行。`visibilitychange` 的隐藏状态是尽早保存的机会，但不能把它包装成对所有崩溃、强退情形的保证。`beforeunload` 只适合存在未保存修改时提示。[Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api#the_unload_event)

**实施建议**：保持已采纳的输入防抖、取舍立即保存；以最新修订写入成功作为显示“已保存”的条件。写入排队期间显示“保存中”，失败显示失败与重试入口，并保留当前内存编辑；不能在旧修订完成时误标新编辑已保存。隐藏时尽早提交待保存内容，关闭时补保存只做尽力处理。防抖窗口内尚未成功保存的末尾输入，在崩溃或退出时可能丢失，应如实定义恢复边界。

## 单编辑页面、单写入者与 MV3 重启

**事实**：MV3 service worker 通常在空闲 30 秒后终止，事件可重新唤醒，但官方要求应对意外终止；其全局变量会丢失。[worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#idle_and_shutdown) 定时器也会随终止取消，事件监听器应在脚本顶层注册。[迁移到 service worker](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#persist_states)

**事实**：标签页 ID 只在一次浏览器会话中唯一；冻结的标签页不能执行任务或定时器，丢弃的标签页会在重新激活时重载。[Tabs 类型](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)

**实施建议**：单页面是产品约束，仍需实现主动查找和聚焦已有页面、并发点击的创建串行化，以及手工复制标签后的写入准入。若由 worker 统一写入，每次唤醒须先读取持久状态再处理命令；单个全局变量、缓存 tabId 或内存 Promise 队列不能作为跨重启的唯一权威。若由编辑页写入，也须先确定当前有效编辑实例。使用会话身份、修订号及可重试命令，避免旧页面或迟到消息覆盖已替换会话；恢复时重新验证页面身份，不盲信历史 tabId。具体协议属于实现选择，官方 API 不自动提供本产品的单写入者保障。

## 本地证据与仍未证明的事项

核查了当前工作区文件清单及两份已有研究，未发现可用于容量判断的真实文章快照、序列化会话样本或实测字节统计。已有权限研究只给出平台配额，不能证明“单篇文章必定低于 10 MiB”或“必须使用 unlimitedStorage”。本轮没有新增原型，也没有验证实际扩展在强退、磁盘不足、连续替换和重复标签场景下的行为。

**实施建议**：如后续需要决定是否省去 `unlimitedStorage`，采集代表性文章和长文，计入原始块 HTML、初始转换、当前编辑以及替换暂存的峰值，用 `getBytesInUse()` 验证实际占用。无论是否声明该权限，都保留写入错误处理，替换成功前保留旧会话。容量选择不能靠未测量的样本假设。[getBytesInUse](https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea/#method-getBytesInUse)
