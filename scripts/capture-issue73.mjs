import { launchChrome } from '../test/chrome.mjs';
import path from 'path';
import fs from 'fs';

const distDir = path.resolve('dist');
const browser = await launchChrome({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  enableExtensions: [distDir],
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const outDir = path.resolve('artifacts/issue73');
fs.mkdirSync(outDir, { recursive: true });

try {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('background.js')
  );
  const worker = await workerTarget.worker();
  const extId = await worker.evaluate(() => chrome.runtime.id);
  const appUrl = `chrome-extension://${extId}/app.html`;

  const page = await browser.newPage();

  const TALL_IMAGE_URL =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="#204060"/><text x="150" y="450" fill="#fff" font-size="24" text-anchor="middle">长竖图示例</text></svg>');
  const NORMAL_IMAGE_URL =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#2d6a4f"/><text x="300" y="180" fill="#fff" font-size="28" text-anchor="middle">标准横图示例</text></svg>');

  const testBlocks = [
    {
      id: 'block-1',
      order: 1,
      type: 'heading',
      headingLevel: 1,
      originalHtml: '<h1>一级标题：骨骼系统概述</h1>',
      initialMarkdown: '# 一级标题：骨骼系统概述',
      editedMarkdown: null,
      included: true,
      notes: [],
    },
    {
      id: 'block-2',
      order: 2,
      type: 'paragraph',
      originalHtml: '<p>人体骨骼系统由 206 块骨骼构成，具有支持体重、保护脏器与造血等多种生理功能。</p>',
      initialMarkdown: '人体骨骼系统由 206 块骨骼构成，具有支持体重、保护脏器与造血等多种生理功能。',
      editedMarkdown: null,
      included: true,
      notes: [{ code: 'table-degraded', message: '部分复杂嵌套表格已平铺降级' }],
    },
    {
      id: 'block-3',
      order: 3,
      type: 'code',
      originalHtml: '<pre><code class="language-js">function inspectBoneDensity(score) {\n  return score &gt; -1.0 ? "normal" : "osteopenia";\n}</code></pre>',
      initialMarkdown: '```js\nfunction inspectBoneDensity(score) {\n  return score > -1.0 ? "normal" : "osteopenia";\n}\n```',
      editedMarkdown: null,
      included: true,
      notes: [],
    },
    {
      id: 'block-4',
      order: 4,
      type: 'table',
      originalHtml: '<table><thead><tr><th>部位</th><th>骨骼名称</th><th>数量</th></tr></thead><tbody><tr><td>颅骨</td><td>脑颅骨</td><td>8</td></tr><tr><td>躯干</td><td>脊椎骨</td><td>26</td></tr></tbody></table>',
      initialMarkdown: '| 部位 | 骨骼名称 | 数量 |\n| --- | --- | --- |\n| 颅骨 | 脑颅骨 | 8 |\n| 躯干 | 脊椎骨 | 26 |',
      editedMarkdown: null,
      included: true,
      notes: [],
    },
    {
      id: 'block-5',
      order: 5,
      type: 'image',
      originalHtml: `<p><img src="${NORMAL_IMAGE_URL}" alt="标准图解"></p>`,
      initialMarkdown: `![标准图解](${NORMAL_IMAGE_URL})`,
      editedMarkdown: null,
      included: true,
      notes: [],
    },
    {
      id: 'block-6',
      order: 6,
      type: 'image',
      originalHtml: `<p><img src="${TALL_IMAGE_URL}" alt="长竖版解剖全图"></p>`,
      initialMarkdown: `![长竖版解剖全图](${TALL_IMAGE_URL})`,
      editedMarkdown: null,
      included: true,
      notes: [{ code: 'richmedia-placeholder', message: '包含超清长图素材' }],
    },
    {
      id: 'block-7',
      order: 7,
      type: 'image',
      originalHtml: '<p><img src="https://example.invalid/not-found-bone-diagram.png" alt="失效示意图"></p>',
      initialMarkdown: '![失效示意图](https://example.invalid/not-found-bone-diagram.png)',
      editedMarkdown: null,
      included: true,
      notes: [{ code: 'convert-failed', message: '图片远程资源无法访问' }],
    },
    {
      id: 'block-8',
      order: 8,
      type: 'paragraph',
      originalHtml: '<p>关注骨骼健康，需要保证足量的钙质摄入与适度的负重运动刺激。</p>',
      initialMarkdown: '关注骨骼健康，需要保证足量的钙质摄入与适度的负重运动刺激。',
      editedMarkdown: null,
      included: false,
      notes: [],
    },
    {
      id: 'block-9',
      order: 9,
      type: 'image',
      originalHtml: `<p><img src="${NORMAL_IMAGE_URL}" alt="剔除折叠带图"></p>`,
      initialMarkdown: `![剔除折叠带图](${NORMAL_IMAGE_URL})`,
      editedMarkdown: null,
      included: false,
      notes: [],
    },
    {
      id: 'block-10',
      order: 10,
      type: 'paragraph',
      originalHtml: '',
      initialMarkdown: '原先内容已被清空',
      editedMarkdown: '',
      included: true,
      notes: [],
    },
  ];

  // 1. 宽屏阅读态
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(appUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-view-mode="empty"]');

  await page.evaluate((blocks) => {
    window.__wetrim.dispatch({
      type: 'INIT_STORAGE_STATE',
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: 'sess-issue73-capture',
          revision: 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            snapshotId: 'snap-issue73',
            capturedAt: new Date().toISOString(),
            source: {
              url: 'https://mp.weixin.qq.com/s/issue73-demo',
              title: '人体骨骼系统全面解析',
              account: '医学科普',
              publishedAt: '2026-10-12',
            },
            blocks,
            images: [],
            captureWarnings: [],
          },
        },
        candidateSnapshot: null,
        corrupted: false,
        isReadOnly: false,
      },
    });
  }, testBlocks);

  await page.waitForSelector('[data-block-id="block-1"]');
  await page.waitForSelector('[data-block-id="block-7"] [data-testid="image-error-card"]');
  await page.screenshot({ path: path.join(outDir, '01-block-types-reading-wide.png') });

  // 2. 窄屏阅读态 (480x800)
  await page.setViewport({ width: 480, height: 800 });
  await page.screenshot({ path: path.join(outDir, '02-block-types-reading-narrow.png') });

  // 3. 宽屏单块编辑态
  await page.setViewport({ width: 1280, height: 900 });
  await page.click('[data-block-id="block-2"] [data-testid="block-action-edit"]');
  await page.waitForSelector('[data-block-id="block-2"] [data-testid="block-editor-textarea"]');
  await page.type('[data-block-id="block-2"] [data-testid="block-editor-textarea"]', '\n\n【实时追加医学要点：骨重占人体体重的 15% 左右】');
  await page.screenshot({ path: path.join(outDir, '03-block-editing-wide.png') });

  // 4. 编辑态内联二次确认条
  await page.click('[data-block-id="block-2"] [data-testid="block-action-restore-content"]');
  await page.waitForSelector('[data-block-id="block-2"] [data-testid="restore-confirm-inline"]');
  await page.screenshot({ path: path.join(outDir, '04-block-editing-restore-confirm.png') });

  // 5. 完成编辑、空白内容与已修改徽章
  await page.click('[data-block-id="block-2"] [data-testid="block-action-finish-edit"]');
  await page.waitForSelector('[data-block-id="block-2"] [data-testid="block-edited-badge"]');
  await page.screenshot({ path: path.join(outDir, '05-block-empty-and-edited-badges.png') });

  // 6. 剔除折叠态与折叠小缩略图
  const block8 = await page.$('[data-block-id="block-8"]');
  if (block8) await block8.scrollIntoView();
  await page.screenshot({ path: path.join(outDir, '06-block-collapsed-summary.png') });

  // 7. 图片呈现（长图渐隐标签与正常缩略图）
  const block6 = await page.$('[data-block-id="block-6"]');
  if (block6) await block6.scrollIntoView();
  await page.screenshot({ path: path.join(outDir, '07-image-normal-and-tall.png') });

  // 8. 图片失败原位卡片
  const block7 = await page.$('[data-block-id="block-7"]');
  if (block7) await block7.scrollIntoView();
  await page.screenshot({ path: path.join(outDir, '08-image-error-card.png') });

  // 9. 查看原图浮层
  await page.click('[data-block-id="block-5"] [data-testid="image-thumbnail-box"]');
  await page.waitForSelector('[data-testid="image-viewer-overlay"][open]');
  await page.screenshot({ path: path.join(outDir, '09-image-viewer-modal.png') });
  await page.click('[data-testid="image-viewer-close-btn"]');
  await page.waitForSelector('[data-testid="image-viewer-overlay"]', { hidden: true });

  // 10. 可见焦点与键盘交互
  await page.focus('[data-block-id="block-1"] [data-testid="block-action-exclude"]');
  await page.screenshot({ path: path.join(outDir, '10-visible-focus-keyboard.png') });

  console.log(`✓ 成功捕获 10 张 Ticket #73 界面截图至：${outDir}`);
} finally {
  await browser.close();
}
