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

const outDir = path.resolve('artifacts/issue74');
fs.mkdirSync(outDir, { recursive: true });

try {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('background.js')
  );
  const worker = await workerTarget.worker();
  const extId = await worker.evaluate(() => chrome.runtime.id);
  const appUrl = `chrome-extension://${extId}/app.html`;

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });

  // 1. 准备旧文章会话
  const oldArticle = {
    kind: 'article',
    source: {
      title: '第一篇文章：技术架构规范与实践指南',
      account: 'WeTrim 设计规范团队',
      publishedAt: '2026-10-10T08:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-old',
    },
    contentHtml: '<h1>规范总览</h1><p>正文内容测试</p>',
    unstable: false,
  };

  const newArticle = {
    kind: 'article',
    source: {
      title: '第二篇文章：微前端解耦与渲染流水线重构',
      account: '前端工程架构周刊',
      publishedAt: '2026-10-12T10:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-new',
    },
    contentHtml: '<h1>重构背景</h1><p>微前端体系下各模块解耦与状态隔离实践。</p>',
    unstable: false,
  };

  await worker.evaluate(() => chrome.storage.local.clear());
  await page.goto(appUrl);
  await page.waitForSelector('[data-view-mode="empty"]');

  // 写入旧文章并触发编辑与剔除以产生明确损失提示
  await page.evaluate((art) => window.__wetrim.processCaptureResult(art), oldArticle);
  await page.waitForSelector('[data-view-mode="cleaning"]');
  await page.waitForSelector('[data-save-status="saved"]');
  // 剔除第一个块
  await page.click('[data-testid="block-action-exclude"]');
  await page.waitForSelector('[data-save-status="saved"]');

  // 2. 抓取新文章触发换稿确认单（桌面端宽屏态）
  await page.evaluate((art) => window.__wetrim.processCaptureResult(art), newArticle);
  await page.waitForSelector('[data-testid="candidate-confirm-card"]');
  await page.screenshot({
    path: path.join(outDir, '01-candidate-confirm-dialog-desktop.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：01-candidate-confirm-dialog-desktop.png');

  // 3. 换稿确认单（移动端 360px 窄屏态）
  await page.setViewport({ width: 360, height: 800 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({
    path: path.join(outDir, '02-candidate-confirm-dialog-mobile.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：02-candidate-confirm-dialog-mobile.png');

  // 恢复宽屏视口
  await page.setViewport({ width: 1200, height: 900 });

  // 4. 替换错误反馈态（模拟存储写入失败）
  await page.evaluate(() => {
    window.originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items) => {
      if (items.currentSession) throw new Error('QUOTA_BYTES_EXCEEDED: 模拟存储空间超限');
      return window.originalSet(items);
    };
  });
  await page.click('[data-testid="candidate-btn-replace"]');
  await page.waitForSelector('[data-testid="candidate-replace-error"]');
  await page.screenshot({
    path: path.join(outDir, '03-candidate-confirm-error.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：03-candidate-confirm-error.png');

  // 恢复原始 storage.set 并点击“继续当前清洗”关闭弹窗
  await page.evaluate(() => {
    if (window.originalSet) chrome.storage.local.set = window.originalSet;
  });
  await page.click('[data-testid="candidate-btn-continue"]');
  await page.waitForSelector('[data-testid="candidate-confirm-card"]', { hidden: true });

  // 5. 原图全屏查看浮层（ImageViewerModal）
  const NORMAL_IMAGE_URL =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#204060"/><text x="400" y="250" fill="#ffffff" font-size="36" text-anchor="middle">WeTrim High-Res Illustration</text></svg>');

  await worker.evaluate((normalUrl) => {
    return chrome.storage.local.set({
      currentSession: {
        schemaVersion: 1,
        sessionId: 'sess-issue74-img',
        revision: 1,
        savedAt: new Date().toISOString(),
        snapshot: {
          snapshotId: 'snap-issue74-img',
          capturedAt: new Date().toISOString(),
          source: {
            url: 'https://mp.weixin.qq.com/s/issue74-img',
            title: '原图查看交互测试文章',
            account: 'WeTrim 设计规范团队',
            publishedAt: '2026-10-12',
          },
          blocks: [
            {
              id: 'b-img-1',
              order: 1,
              type: 'image',
              originalHtml: `<p><img src="${normalUrl}" alt="高分辨率插图"></p>`,
              initialMarkdown: `![高分辨率插图](${normalUrl})`,
              editedMarkdown: null,
              included: true,
              notes: [],
            },
          ],
          images: [{ id: 'img-1', url: normalUrl }],
          captureWarnings: [],
        },
      },
      candidateSnapshot: null,
    });
  }, NORMAL_IMAGE_URL);
  await page.reload();
  await page.waitForSelector('[data-view-mode="cleaning"]');
  await page.waitForSelector('[data-block-id="b-img-1"] [data-testid="image-thumbnail-img"]');

  // 点击缩略图打开原图查看浮层
  await page.click('[data-block-id="b-img-1"] [data-testid="image-thumbnail-box"]');
  await page.waitForSelector('.image-viewer-overlay');
  await page.screenshot({
    path: path.join(outDir, '04-image-viewer-modal.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：04-image-viewer-modal.png');

  // 关闭原图查看浮层
  await page.keyboard.press('Escape');
  await page.waitForSelector('.image-viewer-overlay', { hidden: true });

  // 6. 恢复页清除确认弹窗（RecoveryPanel dialog）
  const unrecognizedRaw = { schemaVersion: 99, snapshot: { notes: ['未识别的版本数据'] }, custom: false };
  await worker.evaluate((raw) => chrome.storage.local.set({ currentSession: raw }), unrecognizedRaw);
  await page.reload();
  await page.waitForSelector('[data-recovery-kind="unrecognized"]');
  await page.click('button.action-replace'); // "清除并重新开始"
  await page.waitForSelector('dialog.recovery-confirm[open]');
  await page.screenshot({
    path: path.join(outDir, '05-recovery-clear-dialog.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：05-recovery-clear-dialog.png');

  console.log('\n=============================================');
  console.log('✓ All Ticket #74 visual evidence captured in artifacts/issue74/');
  console.log('=============================================\n');
} finally {
  await browser.close();
}
