# 验证：浏览器测试

`npm test`（含 `test/verify-csp.mjs`）与 `test/verify-issue*.mjs` 用 Puppeteer 启动 `/usr/bin/google-chrome`，以扩展方式加载 `dist/`。运行前先单独执行一次 `npm run build`。

## 约定

这些命令必须单独成行执行：不加 `cd … &&` 前缀，不接管道、`;` 或 `&&`，也不和 `npm run build` 写在一起。过滤输出不要接 `| tail`、`| grep`，直接读完整输出。

- `npm test`
- `npm run verify:issue<N>`
- `node test/verify-<name>.mjs`

原因是沙箱禁止新建 AF_UNIX socket，而完整版 Chrome 启动时要为进程单例建一个，失败即退出：`process_singleton_posix.cc:297 … socket() failed: 不允许的操作 (1)`。只有命中沙箱 `excludedCommands` 的 `npm test`、`npm run verify*`、`node test/verify-*` 规则时才在沙箱外运行。实测接管道（`… | tail`）或和其他命令串联（`npm run build && …`）都会落回沙箱；`cd <仓库> && …` 当前能命中，但不要依赖。

规则写成 `npm run verify*`，不要写 `npm run verify:*`：实测 `npm run verify:*` 匹配不到 `npm run verify:issue24`，改成 `npm run verify*` 后能命中。

`chrome-headless-shell` 虽能在沙箱内启动，但不支持 `Extensions.loadUnpacked`，不能替代。

## PR 自动检查与本地复现

`.github/workflows/pr-checks.yml` 在 PR 创建、更新、重开时自动运行，也可手动验证。仅有 `contents: read`，不使用 `pull_request_target`、发布凭据或发布命令，不限制提交必须位于 main 历史。

使用 `.node-version` 的 Node、`package.json` 的 `packageManager` 和 `pnpm-lock.yaml`，安装时执行 `pnpm install --frozen-lockfile`。可设置 `PUPPETEER_SKIP_DOWNLOAD=true` 跳过安装阶段的浏览器下载。CI 随后通过 `pnpm exec puppeteer browsers install chrome` 安装 Puppeteer 锁定版本对应的完整版 Chrome，并将 `puppeteer.executablePath()` 传入 `CHROME_PATH`；本地默认 `/usr/bin/google-chrome`，也可按相同步骤准备并指定。`chrome-headless-shell` 不满足加载真实扩展要求。

依赖准备完毕后，独立执行：

```sh
npm run verify:pr
```

该入口先构建（已含 TypeScript 检查），随后运行权限负向输入、双 manifest 权限、发布脚本测试、浏览器探测、`npm test` 和三个核心专项。没有浏览器、加载失败、断言失败或阶段未运行都不能获得整体通过。失败时立即停止，阶段报告明确标记剩余检查为“未执行”。单独运行浏览器专项仍须预先独立构建。

每次结果在独立的 `artifacts/pr/<运行标识>/results.json`，含验证提交及每阶段状态；编号日志与浏览器截图在同目录。可用 `WETRIM_ARTIFACTS` 指定证据根目录；每次生成独立子目录，避免旧截图混入新运行。CI 无论检查成功与否均上传已产生的文件（14 天）；准备阶段失败时查对应 Actions 步骤日志，尚未打开的页面不可能产生截图。

| 核心入口 | 实际覆盖 |
| --- | --- |
| `verify:issue27` | 各块编辑入口、实时修改、去抖保存、空白内容、还原、类型与块身份不变、键盘焦点、编辑高度、4× CPU 性能 |
| `verify:issue38` | 阅读态正文链接左键/中键/Ctrl/Enter 不导航，Markdown 地址保留，含图路径与编辑/取舍可用 |
| `verify:issue39` | 双击正文进入编辑、单一编辑块及旧修改落盘、排除区域、焦点、图片引用入口、600 块性能；保存阅读态与编辑态截图 |

`npm test` 仅是 DOM/CSP 基础检查。核心组合也不等于全部历史工单验收；未包含其他历史专项、真实微信网络、登录与反爬页面、人工视觉及真实用户 action 授权流程。本轮权限场景采用官方依据与技能行为判断，不能把浏览器 fixture 注入当作真实 action 授权测试。

发布工作流仍由版本标签或手动触发，保留原有 main 来源校验、草稿和公开版本不可覆盖规则。PR 中发布脚本测试使用隔离临时文件与替身上传接口，不创建标签或 Release。

## 飞书保存完整专项

独立执行 `npm run verify:feishu`。入口先单独构建，再顺序执行 #58–#66 完整 UI 专项（连接、正文、图片、分篇、标签、恢复、维护、测试保存与组合）。失败即停止，后续明确为未执行。每次 `artifacts/feishu/<运行标识>/results.json` 包含 commit、证据类别、逐阶段状态和编号日志；通过不代表原生权限或真实 API 通过。

正式交付需要分别运行 `npm run verify:pr` 与 `npm run verify:feishu`，不能只运行其中一个。前者保留核心 PR 范围及报告，后者覆盖飞书产品故障注入；勿并发运行带 CPU 性能检查的 PR 入口与其他 Chrome 专项。单独运行 `verify:issue<N>` 前仍先独立构建。

真实 API、真人权限及跨账号模板证据见 [飞书验收索引](../verification/feishu-acceptance.md)，用户说明见 [飞书保存指南](../guides/feishu-save.md)。真实环境不能安装网络/权限替身、直接改授权状态或将测试表秘密写进报告。
