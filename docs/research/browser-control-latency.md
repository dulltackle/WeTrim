# 内置浏览器自动控制延迟诊断

2026-10-07 UTC。范围：本次会话使用的 Codex 内置浏览器，非 WeTrim 扩展自身。状态：已复现并定位到宿主页面控制路径，内部阻塞源尚未确定，未修复。

## 实测结果

所有页面操作均通过 cua_repl 的公开接口执行。未点击表单、写入记录、修改授权或读取凭据。

| 探针 | 耗时 | 结果 |
| --- | ---: | --- |
| 标签列表 | 3 ms | 成功 |
| 飞书 Share 按钮 isVisible | 30,421 ms | true |
| 同一按钮 waitFor，timeoutMs=1000 | 30,034 ms | 成功 |
| 飞书 document.title，timeoutMs=1000 | 30,048 ms | 正确标题 |
| 控制会话重置后，同一页面 document.title | 30,040 ms | 正确标题 |
| 新空白标签 DOM 快照 | 25 ms | 空页面 |
| 新空白标签 document.title | 15 ms | 空标题 |
| 新标签加载同一个飞书副本后 document.title | 30,036 ms | 正确标题 |
| 对照标签导航至 example.com 后 document.title | 13,591 ms | Example Domain |

此外，直接 CDP Page.getLayoutMetrics 调用（参数 timeoutMs=1000）未在工具外层 60 秒内完成，导致 REPL 重置；该批次排在后面的截图没有执行。普通静态页面重复读取及截图的批次也超过 55 秒工具时限，未返回分项结果，不能断言两项分别耗时多少或截图已经执行。

此前用户报告手动操作顺畅，没有逐次计时。不能将人工主观反馈写成精确秒数。

## 最小复现和技能阶段限制

已运行的最小调用：

```javascript
const start = Date.now();
const value = await checkTab.playwright.evaluate(
  () => document.title, undefined, { timeoutMs: 1000 }
);
nodeRepl.write({ ms: Date.now() - start, value });
```

原页面实测输出为 30048 ms；会话重置后 30040 ms，新标签同页面为 30036 ms。超过 2000 ms 判为慢，属于本次诊断阈值，并非产品性能承诺。保存了加入显式失败断言的复用片段 `artifacts/feishu-validation/control-channel-probe.js`；保存后的同一断言版本已通过 cua_repl 执行：`{ elapsedMs: 30035, hasTitle: true, verdict: SLOW }`，随后抛出“页面只读查询超过诊断阈值：30035 ms”。最终复查仍为失败，未宣称修复。

该循环可无人值守并反复捕捉原症状，但每次需要等待约 30 秒，未达到 diagnosing-bugs 的快速循环要求。缩短 API 参数无效；公开接口没有可取消在途请求的句柄。此处明确保留该限制，在不堆积并发请求的前提下继续有限差分测量，不能宣称已建立几秒内完成的回归测试。

测试前向用户列出的假设为：Playwright 调用前额外等待、当前标签/页面状态、整个页面控制通道迟缓、仅元素查找等待。结果排除了“只在元素查找”“只在旧标签”“所有接口都慢”；页面控制路径异常仍然成立，精确等待点尚待跟踪。

## 宿主日志证据

只读检查 `/home/forclaw/.local/state/codex/logs` 最近宿主日志，保存了脱敏摘要 `artifacts/feishu-validation/control-channel-host-errors.json`。本轮临时对照标签为 14。

- 06:41:33.530Z：标签 14 的 debugger listener 因 `cdp-timeout` 被注销。
- 06:41:34.532Z：调试器清理失败，`Emulation.setFocusEmulationEnabled` 超时。
- 06:41:34.533Z：`executeCdp:Page.getFrameTree` 失败，日志明确指出 tab 14 命令超时。

这直接证明宿主的调试命令路径存在超时。不能据此断言此前每个成功返回的 30 秒调用都卡在 Page.getFrameTree。其他 `No ChatGPT browser route` 日志的会话归属未完成匹配，不作为本任务根因证据。

## 本地实现核对

通过只读方式检查已安装客户端脚本及 `/usr/lib/chatgpt/resources/app.asar` 中 `.vite/build/main-B6ZOwXa3.js`，没有执行提取代码或修改安装文件。

- 浏览器客户端将 timeoutMs 转为 timeout_ms，并向执行入口传入 client_timeout_ms；该包装本身没有独立的强制取消计时器。
- 宿主 `executeCdpForBrowserUse` 先取得页面、附加调试器、等待页面就绪，再计算实际命令 deadline。前置阶段没有统一使用这一次命令的剩余时间。
- `waitForTabReadyForCdp` 使用独立的 pageReadyTimeoutMs，安装包默认 15000 ms；CDP 命令默认上限 20000 ms。不能将 30 秒直接解释为“两次 15 秒”，因为尚无分阶段耗时证据。
- 调试命令调用 Electron `webContents.debugger.sendCommand`；失败日志对应此路径，清理还有独立的 1000 ms 超时。

因此存在值得宿主维护者检查的“调用超时没有覆盖全部前置阶段”问题，但尚不能认定它就是本次全部延迟的唯一原因。

## 下一步与交付边界

需要在宿主可调试构建中，为同一个请求记录入口、getTab、attachTab、waitForTabReadyForCdp、waitForPendingDebuggerSync、sendCommand、清理及返回的时间戳；只记命令名、耗时和匿名关联编号，不记录页面内容或凭据。随后将统一 deadline 的候选修复放在真实宿主集成测试中验证，重跑上述页面和空白对照。

WeTrim 仓库没有这个宿主模块的实现或真实测试入口；编写模拟计时器测试不能锁定本故障。本轮未更改 WeTrim 产品代码、宿主安装文件、网络或安全配置，没有提交、发布或发送外部问题报告。

临时对照标签 14 已关闭，清单确认只剩用户原有的测试副本标签 13。未对页面添加临时监听器或调试注入，无需清理页面 instrumentation。

官方浏览器文档用于核对产品能力，不作为内部超时根因的来源：[Browser](https://learn.chatgpt.com/docs/browser?surface=app)。根因判断依据以上本地实测、脱敏日志和安装包只读检查。

## 续查：回调执行前与执行后分离

2026-10-07 00:31 PDT 附近的续查。没有重启或修改宿主，原页面复测仍耗时 30336 ms。

通过公开的只读 evaluate，在读取 document.title 的同一回调内返回 Date.now()，与调用前后时间戳比较：

```text
总耗时             30026 ms
调用开始至回调读取 30025 ms
回调读取至结果返回     1 ms
```

这定位的是只读执行回调的边界，不能将其扩张成 Chromium 内部各阶段的时间线。相同标签的 `tab.title()` 只需 3 ms，`getJsDialog()` 却需 30024 ms，返回没有对话框。

安装的 browser-service.mjs 中，`tab_get_js_dialog` 处理器直接读取 `cdp.getJsDialog()`，后者同步读取 `jsDialogsByTabId` Map，不查询 DOM 或发送 CDP 命令。因此稳态约 30 秒延迟不需要 Playwright 查询或实际页面渲染参与。与回调时间戳结合，最强指向变为**通用命令执行前置链路**。此前调试命令超时是真实的另一组观测，尚未证明它们是固定延迟的共同根因。

只读代码核对显示，命令分发前的 `security.runCommand → ensureCommandAllowed` 会读取当前标签，进行网址检查及权限检查。`get_tab`、`list_tabs` 不经过相同的当前网址检查；网站状态检查会在没有缓存结果时等待请求完成。这能解释现有差分，但没有对应请求的分阶段日志，所以**网站状态检查超时仅为待验证假设**，不能写成已证实根因。没有禁用检查、读取或改变检查配置，也没有直接调用带凭据的内部接口。

尝试建立固定纯文本的 localhost 对照服务，但浏览器返回 `ERR_BLOCKED_BY_CLIENT`，未取得该对照的性能结果。没有更换地址或通道规避拦截。临时服务已以退出码 130 停止，临时标签 15 已关闭；清单仅剩用户标签 13。

同期桌面日志还有 durable 远程连接的 ETIMEDOUT / app-server unavailable；未证明属于当前控制请求，不作为根因。无凭据 curl 检查 chatgpt.com 返回 HTTP 403，耗时约 0.824 秒；该路径不同于浏览器内部检查请求，同样不能证实或排除该假设。

新增可复用探针和实测数据分别位于 `artifacts/feishu-validation/control-channel-phase-probe.js`、`control-channel-phase-results.json`。下一步应优先在真实宿主跟踪中测量：命令入口、当前网址读取、网站状态检查、权限检查、处理器进入、调试命令及返回。不得关闭检查来测试真实飞书页面；应通过正常测试环境或维护者提供的跟踪能力验证。
