# 扩展发布流程

状态：工作流与本地脚本已实现，`v1.0.0` 已通过远端构建、草稿上传及下载校验。

## 分发范围与术语

使用 GitHub Release 分发扩展 ZIP，本次不接入 Chrome 扩展商店。

- **扩展发布压缩包**：供下载、解压并加载扩展的 ZIP。与 `GLOSSARY.md` 中表示文章及图片的「导出产物」区分。
- **Release 草稿**：关联版本标签、含发布说明与附件，但尚未向普通用户公开的 GitHub 发布记录。

## 已确认的发布规则

1. 推送 `v主版本.次版本.修订号` 标签触发工作流，例如 `v1.0.0`。暂不支持预发布后缀。各段为 0–65535 的整数，不能有前导零，不能全为零。
2. 标签指向的提交必须属于 `main` 的历史；允许发布其中的历史提交。
3. `package.json`、`public/manifest.json` 与标签版本必须一致，否则终止。
4. 必须通过发布脚本测试、TypeScript 检查、Vite 构建、DOM 访问检查、CSP 浏览器验证与 ZIP 完整性检查。现有全部专项回归不作为本次发布门槛。
5. 自动创建草稿并上传 ZIP、SHA-256 校验文件，维护者检查后手动公开。
6. 同一标签的工作流串行执行。失败后允许重跑，更新草稿中的同名附件，并保留维护者编辑过的说明。已公开版本拒绝覆盖，修复应发布新版本。

## 环境与产物

Node.js 固定在 `.node-version`，pnpm 固定在 `package.json` 的 `packageManager`，工作流安装同一版本。依赖用 `pnpm install --frozen-lockfile` 安装。

Action 自身使用 Node 24 运行时（checkout v5、setup-node v6、github-script v8），与项目构建使用的 Node 22 分别配置。发布脚本测试会在两种运行时下分别执行，检查上传逻辑的兼容性。

本地打包还需要 Python 3，脚本只使用标准库。GitHub 工作流运行于 Ubuntu 24.04，使用镜像预装的 `/usr/bin/google-chrome` 完整版；若镜像不再提供该路径，环境检查会失败。Puppeteer 下载被跳过，浏览器验证遵循 `docs/agents/verification.md`。

附件输出到忽略入库的 `release/`：

- `WeTrim-<版本>.zip`
- `WeTrim-<版本>.zip.sha256`

ZIP 只包含 `dist/` 文件，根目录直接包含 `manifest.json`；不添加外层目录。脚本拒绝符号链接、隐藏文件、源码和 source map，检查必需入口、图标及脚本，随后读取 ZIP，校验 CRC、完整文件列表及每个文件的字节内容。同一构建结果重复打包使用固定时间戳和文件顺序。

新建草稿使用 GitHub 自动生成的变更说明，并附下载、解压、Chrome 开发者模式加载及校验说明。

## 本地验证与打包

在项目根目录分别执行：

```bash
pnpm install --frozen-lockfile
npm run test:release
npm run build
npm test
npm run package:release
```

`package:release` 只打包已有构建，不替代前面的构建和测试；源码变更后必须重新构建。基础测试需要完整版 Chrome。

## 发布操作

仅验证工作流时，可在 Actions 中选择「构建扩展发布草稿」，点击「Run workflow」并选择 `main`，或运行 `gh workflow run release.yml --ref main`。手动运行检查版本、main 来源、构建、测试与 ZIP 完整性，并在 Action 的 Node 24 下执行发布脚本测试；上传步骤跳过，不创建标签，也不创建或修改 Release。产物只用于本次运行检查，不上传到 Release。

工作流升级后应使用此入口验证。重跑旧标签的历史运行仍使用旧提交的配置，无法验证后来修改的工作流。

1. 使用 `npm run version:set -- 1.0.1` 同步版本。首次发布现有 `1.0.0` 可跳过。
2. 检查并提交变更，完成评审并合入 `main`。首次发布必须先合入本工作流。
3. 在确认要发布的提交上运行 `npm run version:check -- v1.0.1`。
4. 创建并推送该版本标签：

```bash
git tag -a v1.0.1 -m "发布 WeTrim 1.0.1"
git push origin v1.0.1
```

5. 在 Actions 中等待「构建扩展发布草稿」成功。失败时修复原因并重跑；若需修改已打标签的代码，使用新版本，不移动已有标签。
6. 打开对应 Release 草稿，检查版本、变更说明、两份附件；下载并解压 ZIP，在 Chrome 中加载验证。可在下载目录运行 `sha256sum -c WeTrim-1.0.1.zip.sha256`。
7. 确认工作流结束后手动公开草稿。不要在上传仍进行时公开：GitHub API 的「检查草稿状态」和「修改附件」不是原子操作，无法消除两者之间的人为并发操作窗口。

上传使用工作流自带的 `GITHUB_TOKEN` 与 `contents: write`，无需配置个人令牌；仓库或组织策略必须允许这一权限。实现和本地测试不会创建远端标签或 Release。

## 参考

- [GitHub Release API](https://docs.github.com/en/rest/releases/releases)：草稿创建、自动变更说明与状态查询。
- [GitHub Release 附件 API](https://docs.github.com/en/rest/releases/assets)：附件上传与删除。
