import { readFileSync, writeFileSync } from 'node:fs';

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      version.split('.').some((part) => Number(part) > 65535) || version === '0.0.0') {
    throw new Error('版本必须为三个 0–65535 的整数，无前导零，且不能全为零。');
  }
  return version;
}

const paths = ['package.json', 'public/manifest.json'];
const documents = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
const [command, argument] = process.argv.slice(2);
if (command === 'set') {
  const version = validateVersion(argument);
  documents.forEach((document, index) => {
    document.version = version;
    writeFileSync(paths[index], `${JSON.stringify(document, null, 2)}\n`);
  });
  console.log(`已同步版本：${version}，请检查并提交两个文件。`);
} else if (command === 'check') {
  const version = validateVersion(documents[0].version);
  if (documents[1].version !== version) throw new Error('package.json 与 manifest 版本不一致。');
  if (argument !== undefined && argument !== `v${version}`) throw new Error('标签与项目版本不一致。');
  console.log(version);
} else {
  throw new Error('用法：node scripts/release-version.mjs set <版本> 或 check [标签]');
}
