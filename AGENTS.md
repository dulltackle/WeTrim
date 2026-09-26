# WeTrim

## Agent skills

### Issue tracker

Issue 存放在本仓库的 GitHub Issues，通过 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范角色的默认标签名。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## Verification

浏览器测试（`npm test`、`npm run verify:*`、`node test/verify-*`）必须单独成行执行。见 `docs/agents/verification.md`。
