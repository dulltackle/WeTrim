# 域文档（Domain Docs）

各个工程类 skill 在探索代码库时，应当如何消费本仓库的域文档。

## 开始探索之前，先读这些

- 根目录的 **`CONTEXT.md`**；或者
- 根目录的 **`CONTEXT-MAP.md`**（如果存在）：它指向每个上下文各自的 `CONTEXT.md`。与当前话题相关的都要读。
- **`docs/adr/`**：读那些与你即将动手的区域相关的 ADR。在多上下文仓库中，还要检查 `src/<context>/docs/adr/` 下按上下文划分的决策。

如果这些文件不存在，**静默继续**。不要提示它们缺失，也不要一上来就建议创建。`/domain-modeling` skill（可经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 触达）会在术语或决策真正需要落定时按需创建它们。

## 文件结构

单上下文仓库（**本仓库采用这种布局**）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md` 即为此类）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 该上下文专属的决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表里的措辞

当你的产出中出现某个领域概念时（issue 标题、重构方案、假设、测试名称），使用 `CONTEXT.md` 中所定义的那个术语。不要漂移到词汇表明确回避的同义词上。

如果你需要的概念还不在词汇表里，这本身就是个信号：要么你在发明这个项目并不使用的语言（该重新考虑），要么确实存在一处真空（记下来交给 `/domain-modeling`）。

## 标记与 ADR 的冲突

如果你的产出与某条既有 ADR 相矛盾，要明确点出来，而不是悄悄覆盖：

> _与 ADR-0007（event-sourced orders）相矛盾，但值得重新讨论，因为……_
