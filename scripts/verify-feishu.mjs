import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const directory = resolve(process.env.WETRIM_ARTIFACTS || 'artifacts/feishu', runId);
console.log(`本次证据目录：${directory}`);
mkdirSync(directory, { recursive: true });
// 真实构建与 local；飞书网络/权限响应是明确替身，不能表示真实授权或 API 通过。
const stages = [
  ['构建（含类型检查）', 'npm', ['run', 'build']],
  ...Array.from({length:9},(_,index)=>[`飞书 #${58+index}（产品故障注入）`, 'npm', ['run', `verify:issue${58+index}`]]),
];
const results = stages.map(([name]) => ({ name, status: '未执行' }));
const report = () => {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ evidence: '真实构建及 local；飞书网络和权限响应替身，非真实 API 或原生授权', commit: process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim(), results }, null, 2));
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
