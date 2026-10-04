// 仅操作草稿；重跑时保留维护者已编辑的发布说明。
module.exports = async ({ github, context }) => {
  const fs = require('node:fs');
  const { owner, repo } = context.repo;
  const tag = process.env.RELEASE_TAG;
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (tag !== `v${version}`) throw new Error('标签与版本不一致');
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  let release = releases.find((item) => item.tag_name === tag);
  if (release && !release.draft) throw new Error('该版本已公开，禁止覆盖，请发布新版本');
  if (!release) {
    const { data: notes } = await github.rest.repos.generateReleaseNotes({ owner, repo, tag_name: tag, target_commitish: context.sha });
    const body = `${notes.body}\n\n## 安装\n\n1. 下载 WeTrim-${version}.zip 并解压到固定目录。\n2. 打开 chrome://extensions，开启「开发者模式」。\n3. 点击「加载已解压的扩展程序」，选择含 manifest.json 的目录。\n\n请保留解压目录。升级时解压新版本，并在扩展管理页重新加载；移动目录可能需要重新加载扩展。\n\n附件提供 SHA-256 校验文件，可在下载目录运行 sha256sum -c WeTrim-${version}.zip.sha256。\n`;
    ({ data: release } = await github.rest.repos.createRelease({ owner, repo, tag_name: tag, name: `WeTrim ${tag}`, body, draft: true, prerelease: false }));
  }
  for (const name of [`WeTrim-${version}.zip`, `WeTrim-${version}.zip.sha256`]) {
    // 每次写入前重新检查，避免重跑修改已经公开的版本。
    const { data: current } = await github.rest.repos.getRelease({ owner, repo, release_id: release.id });
    if (!current.draft) throw new Error('该版本已公开，停止上传');
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id, per_page: 100 });
    for (const asset of assets.filter((item) => item.name === name)) {
      await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id });
    }
    const data = fs.readFileSync(`release/${name}`);
    await github.rest.repos.uploadReleaseAsset({ owner, repo, release_id: release.id, name, data, headers: { 'content-type': name.endsWith('.zip') ? 'application/zip' : 'text/plain', 'content-length': data.length } });
  }
  console.log(`草稿已准备好：${release.html_url}`);
};
