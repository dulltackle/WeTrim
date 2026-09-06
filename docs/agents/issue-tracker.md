# Issue 追踪：GitHub

本仓库的 issue 与 spec 都存放在 GitHub Issues。所有操作使用 `gh` CLI。

## 当前仓库状态（重要）

本目录**尚未 `git init`，也没有关联任何 remote**，因此 `gh` 无法自动推断仓库。

在完成 `git init` 并关联 GitHub remote 之前，下文所有 `gh` 命令都必须显式加上 `--repo <owner>/<repo>`。一旦仓库建好并有了 remote，即可省略该参数——`gh` 会自动从 `git remote -v` 推断。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **查看 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，同时取回标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **增删标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭 issue**：`gh issue close <number> --comment "..."`

在 clone 内运行时 `gh` 会自动从 `git remote -v` 推断仓库。

## 把 Pull Request 当作 triage 入口

**PRs as a request surface: no.** _（如果本仓库把外部 PR 也当成需求来源，就改成 `yes`；`/triage` 会读取这个开关。）_

设为 `yes` 时，PR 与 issue 走同一套标签和状态，只是换成 `gh pr` 系列命令：

- **查看 PR**：`gh pr view <number> --comments`，看 diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（丢弃 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用同一套编号空间，所以裸写的 `#42` 可能是任意一种：先用 `gh pr view 42` 解析，失败再回退到 `gh issue view 42`。

## 当某个 skill 说「发布到 issue 追踪器」

创建一个 GitHub issue。

## 当某个 skill 说「取回相关 ticket」

执行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个 issue，每个 ticket 是它的**子 issue**。

- **Map**：一个打了 `wayfinder:map` 标签的 issue，正文承载 Notes / Decisions-so-far / Fog。用 `gh issue create --label wayfinder:map` 创建。
- **子 ticket**：作为 GitHub sub-issue 挂到 map 上（用 `gh api` 调 sub-issues 接口）。若未启用 sub-issues，则退化为在 map 正文的任务列表里加一项，并在子 issue 正文顶部写 `Part of #<map>`。标签为 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。ticket 一旦被认领，就指派给推进它的开发者。
- **阻塞关系**：使用 GitHub 的**原生 issue dependencies**，这是规范的、在 UI 上可见的表示方式。添加一条边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number`，也不是 `node_id`）。GitHub 会返回 `issue_dependencies_summary.blocked_by`（只统计未关闭的阻塞方，这是实时的判定依据）。若 dependencies 不可用，则退化为在子 issue 正文顶部写一行 `Blocked by: #<n>, #<n>`。当所有阻塞方都已关闭时，该 ticket 解除阻塞。
- **Frontier 查询**：列出 map 下所有未关闭的子 issue（`gh issue list --state open`，范围限定为该 map 的 sub-issues / 任务列表），剔除仍有未关闭阻塞方的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有未关闭的 issue）以及已有 assignee 的；剩下的按 map 中的顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一个写操作。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把一条上下文指针（要点 + 链接）追加到 map 的 Decisions-so-far 中。
