# WeTrim

## Agent skills

### Issue tracker

Issue 存放在本仓库的 GitHub Issues，通过 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

`gh` 命令必须单独成行执行：不加 `cd … &&` 前缀，不接管道、`;` 或 `&&`，过滤输出用 `--json` / `--jq`。

原因是 `gh` 的 token 存在系统 keyring，只有命中沙箱 `excludedCommands` 的 `gh *` 规则时才在沙箱外运行；复合命令匹配不上，会落回沙箱，读不到 token，返回 `HTTP 401`。

### Triage labels

沿用五个规范角色的默认标签名。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## Verification

浏览器测试（`npm test`、`npm run verify:*`、`node test/verify-*`）必须单独成行执行。见 `docs/agents/verification.md`。
