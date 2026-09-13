import fs from 'fs';
import path from 'path';

/**
 * 依据 Issue #24、ADR-0005 与 ARCHITECTURE.md §7：
 * 全部块的渲染入口收敛到单一的 BlockList 组件边界。
 * 搜索、序号定位与焦点管理必须经由 BlockList 暴露的接口，不得绕过它访问 DOM。
 *
 * 规则：BlockList 以外的任何模块不得出现 document.querySelector / document.getElementById / 直接的 DOM 节点查找。
 * 在 src/app 目录下检查所有 .ts 与 .tsx 文件：
 * - 允许 src/app/main.tsx 中挂载 React 根节点的 document.getElementById('root')
 * - 允许 src/app/components/BlockList.tsx（BlockList 组件本身作为接缝边界）
 * - 其他任何模块出现 document.querySelector / querySelectorAll / getElementById / getElementsBy* 均视为违规
 */

const APP_DIR = path.resolve('src/app');
const FORBIDDEN_PATTERNS = [
  /document\.querySelector\b/,
  /document\.querySelectorAll\b/,
  /document\.getElementById\b/,
  /document\.getElementsByClassName\b/,
  /document\.getElementsByTagName\b/,
  /document\.getElementsByName\b/,
];

export function checkDomAccess() {
  function getSourceFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getSourceFiles(fullPath));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const files = getSourceFiles(APP_DIR);
  const violations = [];

  for (const file of files) {
    const relative = path.relative(process.cwd(), file);
    // 允许 BlockList 组件
    if (relative === 'src/app/components/BlockList.tsx') {
      continue;
    }

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // 允许 main.tsx 中用于 ReactDOM.createRoot 的 document.getElementById('root')
      if (relative === 'src/app/main.tsx' && line.includes("document.getElementById('root')")) {
        return;
      }

      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file: relative,
            line: index + 1,
            content: line.trim(),
            pattern: pattern.source,
          });
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error('❌ CI Check Failed: Direct DOM access detected outside BlockList:');
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.content}`);
    }
    return false;
  }

  console.log('✓ CI Rule Passed: No direct DOM queries outside BlockList in src/app.');
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('check-dom-access.mjs')) {
  const ok = checkDomAccess();
  if (!ok) {
    process.exit(1);
  }
}
