import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const approved = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
function check(source, built) {
  const dir = mkdtempSync(join(tmpdir(), 'wetrim-permissions-'));
  try {
    for (const [name, value] of [['source', source], ['built', built]]) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
    return spawnSync(process.execPath, ['scripts/check-permissions.mjs', join(dir, 'source.json'), join(dir, 'built.json')], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true }); }
}
test('权限 CLI 接受已审核源码与构建声明', () => {
  const result = check(approved, approved);
  assert.equal(result.status, 0, result.stderr);
});
for (const [name, mutate] of [
  ['新增 tabs', m => m.permissions.push('tabs')],
  ['扩大图片域名', m => m.host_permissions.push('<all_urls>')],
  ['新增可选 API 权限', m => { m.optional_permissions = ['tabs']; }],
  ['新增可选域名', m => { m.optional_host_permissions = ['https://*/*']; }],
  ['构建声明缺失', m => { m.permissions = m.permissions.filter(p => p !== 'activeTab'); }],
]) {
  test(`权限 CLI 拒绝${name}（源码或构建任一越界）`, () => {
    const changed = structuredClone(approved);
    mutate(changed);
    for (const pair of [[changed, approved], [approved, changed], [changed, changed]]) {
      const result = check(...pair);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /偏离审核基线/);
    }
  });
}
