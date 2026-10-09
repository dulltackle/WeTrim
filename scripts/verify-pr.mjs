import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const directory = resolve(process.env.WETRIM_ARTIFACTS || 'artifacts/pr', runId);
console.log(`本次证据目录：${directory}`);
mkdirSync(directory, { recursive: true });
const stages = [
  ['构建（含类型检查）', 'npm', ['run', 'build']],
  ['权限负向测试', 'npm', ['run', 'test:permissions']],
  ['源码与构建权限', 'npm', ['run', 'check:permissions']],
  ['发布脚本', 'npm', ['run', 'test:release']],
  ['完整版 Chrome 探测', process.env.CHROME_PATH || '/usr/bin/google-chrome', ['--version']],
  ['DOM 与真实扩展 CSP', 'npm', ['test']],
  ['行内字体段落边界', 'node', ['test/verify-paragraph-inline.mjs']],
  ['核心 #27', 'npm', ['run', 'verify:issue27']],
  ['核心 #38', 'npm', ['run', 'verify:issue38']],
  ['核心 #39', 'npm', ['run', 'verify:issue39']],
];
const results = stages.map(([name]) => ({ name, status: '未执行' }));
const report = () => {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ commit: process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim(), results }, null, 2));
};
report();
for (const [index, [name, command, args]] of stages.entries()) {
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, WETRIM_ARTIFACTS: directory } });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error.message}` : ''}`;
  writeFileSync(resolve(directory, `${index + 1}.log`), output);
  process.stdout.write(output);
  results[index] = { name, status: result.status === 0 && !result.error ? '通过' : '失败', exitCode: result.status, signal: result.signal, error: result.error?.message };
  report();
  if (results[index].status === '失败') { process.exitCode = 1; break; }
}
const summary = results.map(({ name, status }) => `- ${name}：${status}`).join('\n');
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
