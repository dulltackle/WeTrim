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
