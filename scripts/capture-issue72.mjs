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

const outDir = path.resolve('artifacts/issue72');
fs.mkdirSync(outDir, { recursive: true });

try {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('background.js')
  );
  const worker = await workerTarget.worker();
  const extId = await worker.evaluate(() => chrome.runtime.id);
  const appUrl = `chrome-extension://${extId}/app.html`;

  const page = await browser.newPage();

  // 1. 宽屏空态 (1280x800)
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(appUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="empty-state-view"]');
  await page.screenshot({ path: path.join(outDir, '01-empty-state-wide.png') });

  // 2. 窄屏空态 (480x800)
  await page.setViewport({ width: 480, height: 800 });
  await page.screenshot({ path: path.join(outDir, '02-empty-state-narrow.png') });

  // 3. 宽屏清洗态工作台 (1280x900)
  await page.setViewport({ width: 1280, height: 900 });
  const testBlocks = [
    {
      id: 'block-1',
      order: 1,
      type: 'paragraph',
      originalHtml: '<p>人体骨骼系统由206块骨骼构成，具有支持体重、保护脏器与造血等多种生理功能。</p>',
      markdown: '人体骨骼系统由206块骨骼构成，具有支持体重、保护脏器与造血等多种生理功能。',
      editedMarkdown: '人体骨骼系统由206块骨骼构成，具有支持体重、保护脏器与造血等多种生理功能。',
      included: true,
      notes: [],
    },
    {
      id: 'block-2',
      order: 2,
      type: 'paragraph',
      originalHtml: '<p>骨骼组织通过破骨与成骨细胞的协同作用，每隔约10年便会完成一次几乎全新的更新重塑。</p>',
      markdown: '骨骼组织通过破骨与成骨细胞的协同作用，每隔约10年便会完成一次几乎全新的更新重塑。',
      editedMarkdown: '骨骼组织通过破骨与成骨细胞的协同作用，每隔约10年便会完成一次几乎全新的更新重塑。',
      included: true,
      notes: [],
    },
    {
      id: 'block-3',
      order: 3,
      type: 'paragraph',
      originalHtml: '<p>关注骨骼健康，需要保证足量的钙质摄入与适度的负重运动刺激。</p>',
      markdown: '关注骨骼健康，需要保证足量的钙质摄入与适度的负重运动刺激。',
      editedMarkdown: '关注骨骼健康，需要保证足量的钙质摄入与适度的负重运动刺激。',
      included: false,
      notes: [],
    },
  ];

  await page.evaluate((blocks) => {
    const { dispatch } = window.__wetrim;
    dispatch({
      type: 'INIT_STORAGE_STATE',
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: 'sess-issue72-capture',
          revision: 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            articleId: 'art-72',
            capturedAt: new Date().toISOString(),
            source: {
              url: 'https://mp.weixin.qq.com/s/issue72-sample',
              title: '骨骼健康指南与科学清洗实践',
              account: '科学编辑室',
              publishedAt: '2026-10-12',
            },
            blocks,
            captureWarnings: [],
          },
        },
        candidateSnapshot: null,
        corrupted: false,
        isReadOnly: false,
      },
    });
  }, testBlocks);

  await page.waitForSelector('[data-testid="block-items-stream"]');
  await page.screenshot({ path: path.join(outDir, '03-workbench-wide-cleaning.png') });

  // 4. 窄屏清洗态工作台 (480x800)
  await page.setViewport({ width: 480, height: 800 });
  await page.screenshot({ path: path.join(outDir, '04-workbench-narrow-cleaning.png') });

  // 恢复宽屏进行交互截图
  await page.setViewport({ width: 1280, height: 900 });

  // 5. 搜索与高亮展示
  await page.type('[data-testid="search-input"]', '骨骼');
  await page.waitForSelector('[data-testid="search-counter"]');
  await page.screenshot({ path: path.join(outDir, '05-search-and-nav-highlight.png') });

  // 6. 「跳至 #」序号定位气泡展示
  await page.type('[data-testid="order-jump-input"]', '99');
  await page.click('[data-testid="order-jump-btn"]');
  await page.waitForSelector('[data-testid="order-jump-tip"]');
  await page.screenshot({ path: path.join(outDir, '06-order-jump-popover.png') });

  // 7. 筛选页签切换至「保留」
  await page.click('[data-testid="filter-tab-included"]');
  await page.screenshot({ path: path.join(outDir, '07-filter-tabs-active.png') });

  // 8. 审校退单卡片（微信提示页）
  await page.evaluate(() => {
    const { processCaptureResult } = window.__wetrim;
    processCaptureResult({
      kind: 'wechatNotice',
      noticeText: '该公众号已被封禁，所有内容不可查看',
    });
  });
  await page.waitForSelector('[data-testid="return-notice-card"]');
  await page.screenshot({ path: path.join(outDir, '08-return-notice-wechat.png') });

  // 9. 整篇级失败卡片
  await page.evaluate(() => {
    const { dispatch } = window.__wetrim;
    dispatch({
      type: 'SET_SPLIT_ERROR',
      payload: { message: 'DOM 结构损坏或文章内容为空', url: 'https://mp.weixin.qq.com/s/sample' },
    });
  });
  await page.waitForSelector('[data-testid="article-failure-card"]');
  await page.screenshot({ path: path.join(outDir, '09-article-failure-card.png') });

  // 10. 恢复页面（损坏记录/读取受阻）
  await page.evaluate(() => {
    const { dispatch } = window.__wetrim;
    dispatch({
      type: 'SET_RECOVERY',
      payload: { kind: 'unrecognized', raw: { snapshot: { title: '未识别版本记录' } } },
    });
  });
  await page.waitForSelector('[data-testid="corrupted-record-card"]');
  await page.screenshot({ path: path.join(outDir, '10-recovery-corrupted-record.png') });

  console.log('Issue #72 screenshots successfully captured in', outDir);
} finally {
  await browser.close();
}
