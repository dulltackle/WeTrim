import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import upload from '../scripts/upload-release.cjs';

const root = resolve('.');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wetrim-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const manifest = { version: '1.0.0', background: { service_worker: 'background.js' }, icons: { 16: 'icons/icon.png' } };
  writeFileSync(join(dir, 'public/manifest.json'), JSON.stringify(manifest));
  return dir;
}
function run(dir, program, args) {
  return spawnSync(program, args, { cwd: dir, encoding: 'utf8' });
}

test('版本同步并拒绝不匹配标签和非法扩展版本', (t) => {
  const dir = fixture(t);
  const version = (...args) => run(dir, process.execPath, ['scripts/release-version.mjs', ...args]);
  assert.equal(version('set', '2.3.4').status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'public/manifest.json'))).version, '2.3.4');
  assert.equal(version('check', 'v2.3.4').status, 0);
  for (const invalid of ['01.2.3', '1.2.3-beta', '65536.1.0', '0.0.0']) assert.notEqual(version('set', invalid).status, 0);
  assert.notEqual(version('check', 'v2.3.5').status, 0);
  writeFileSync(join(dir, 'public/manifest.json'), '{"version":"1.0.0"}');
  assert.notEqual(version('check').status, 0);
});

test('ZIP 可重复生成，并拒绝缺失文件、过期 manifest 和源码', (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'dist/assets'), { recursive: true });
  mkdirSync(join(dir, 'dist/icons'));
  cpSync(join(dir, 'public/manifest.json'), join(dir, 'dist/manifest.json'));
  for (const name of ['app.html', 'background.js', 'assets/app.js', 'icons/icon.png']) writeFileSync(join(dir, 'dist', name), 'fixture');
  const pack = () => run(dir, 'python3', ['scripts/package-release.py']);
  assert.equal(pack().status, 0);
  const first = readFileSync(join(dir, 'release/WeTrim-1.0.0.zip'));
  assert.equal(pack().status, 0);
  assert.deepEqual(readFileSync(join(dir, 'release/WeTrim-1.0.0.zip')), first);
  writeFileSync(join(dir, 'dist/debug.ts'), 'secret');
  assert.notEqual(pack().status, 0);
  rmSync(join(dir, 'dist/debug.ts'));
  rmSync(join(dir, 'dist/background.js'));
  assert.notEqual(pack().status, 0);
  writeFileSync(join(dir, 'dist/background.js'), 'fixture');
  writeFileSync(join(dir, 'dist/manifest.json'), '{"version":"9.0.0"}');
  assert.notEqual(pack().status, 0);
});

function mockGithub(release, publishDuringUpload = false) {
  const calls = [];
  const repos = {};
  for (const method of ['listReleases', 'listReleaseAssets']) repos[method] = method;
  repos.getRelease = async () => ({ data: publishDuringUpload ? { ...release, draft: false } : release });
  repos.generateReleaseNotes = async () => ({ data: { body: '变更说明' } });
  repos.createRelease = async (args) => { calls.push(['create', args]); release = { ...args, id: 1, html_url: 'https://example.test/draft' }; return { data: release }; };
  repos.deleteReleaseAsset = async (args) => calls.push(['delete', args]);
  repos.uploadReleaseAsset = async (args) => calls.push(['upload', args]);
  return { calls, rest: { repos }, paginate: async (method) => method === 'listReleases' ? (release ? [release] : []) : [{ id: 7, name: 'WeTrim-1.0.0.zip' }] };
}

test('上传只更新草稿附件，拒绝公开版本与上传前变为公开的版本', async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'release'));
  for (const name of ['WeTrim-1.0.0.zip', 'WeTrim-1.0.0.zip.sha256']) writeFileSync(join(dir, 'release', name), 'fixture');
  const oldCwd = process.cwd();
  const oldTag = process.env.RELEASE_TAG;
  process.chdir(dir);
  process.env.RELEASE_TAG = 'v1.0.0';
  try {
    const context = { repo: { owner: 'test', repo: 'test' }, sha: 'abc' };
    for (const draft of [true, false]) {
      const github = mockGithub({ id: 1, tag_name: 'v1.0.0', draft });
      if (draft) {
        await upload({ github, context });
        assert.deepEqual(github.calls.map(([name]) => name), ['delete', 'upload', 'upload']);
      } else {
        await assert.rejects(upload({ github, context }), /已公开/);
        assert.equal(github.calls.length, 0);
      }
    }
    const github = mockGithub(null);
    await upload({ github, context });
    assert.equal(github.calls[0][0], 'create');
    assert.equal(github.calls[0][1].draft, true);
    assert.match(github.calls[0][1].body, /chrome:\/\/extensions/);
    const race = mockGithub({ id: 1, tag_name: 'v1.0.0', draft: true }, true);
    await assert.rejects(upload({ github: race, context }), /已公开/);
    assert.equal(race.calls.length, 0);
  } finally {
    process.chdir(oldCwd);
    if (oldTag === undefined) delete process.env.RELEASE_TAG;
    else process.env.RELEASE_TAG = oldTag;
  }
});
