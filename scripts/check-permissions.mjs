import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const baseline = JSON.parse(readFileSync(new URL('../config/permissions-baseline.json', import.meta.url), 'utf8'));
  for (const [field, permissions] of Object.entries(baseline)) {
    if (!permissions || Array.isArray(permissions) || typeof permissions !== 'object' || Object.values(permissions).some(reason => typeof reason !== 'string' || !reason.trim())) throw new Error(`${field} 基线须逐项记录审核理由`);
  }
  if (process.argv.length !== 2 && process.argv.length !== 4) throw new Error('用法：node scripts/check-permissions.mjs [源码 manifest 路径 构建 manifest 路径]');
  for (const file of process.argv.slice(2).length ? process.argv.slice(2) : ['public/manifest.json', 'dist/manifest.json']) {
    const manifest = JSON.parse(readFileSync(resolve(file), 'utf8'));
    for (const field of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions']) {
      const actual = manifest[field] ?? [];
      const expected = Object.keys(baseline[field]);
      if (!Array.isArray(actual) || actual.some(value => typeof value !== 'string') || new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify(expected.sort())) {
        throw new Error(`${file}: ${field} 超出或偏离审核基线；实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}。修改边界须在基线中说明理由并接受审查。`);
      }
    }
    console.log(`权限通过：${file}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
