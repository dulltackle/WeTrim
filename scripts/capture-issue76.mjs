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

const outDir = path.resolve('artifacts/issue76');
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

  await worker.evaluate(() => chrome.storage.local.clear());
  await page.goto(appUrl);
  await page.waitForSelector('[data-view-mode="empty"]');

  // 文章 1：普通正文文章（用于测试导出成功与空正文拦截）
  const sampleArticle = {
    kind: 'article',
    source: {
      title: 'WeTrim 视觉重构与样式规范指南',
      account: '前端工程设计团队',
      publishedAt: '2026-10-12T08:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-export',
    },
    contentHtml: `
      <h1>视觉规范导言</h1>
      <p>遵循纸张底色与普鲁士蓝视觉基调，导出结果呈现清晰结构。</p>
      <p>第二段：连续单栏排版与导出流程无缝结合。</p>
    `,
    unstable: false,
  };

  await page.evaluate((art) => window.__wetrim.processCaptureResult(art), sampleArticle);
  await page.waitForSelector('[data-view-mode="cleaning"]');
  await page.waitForSelector('[data-save-status="saved"]');

  // 场景 1: 导出成功反馈弹窗 (桌面视口 1200x900)
  console.log('==> 捕获场景 1: 导出成功反馈弹窗...');
  await page.evaluate(async () => {
    const rootDir = await navigator.storage.getDirectory();
    const target = await rootDir.getDirectoryHandle('export-target-success', { create: true });
    window.showDirectoryPicker = async () => target;
  });
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="export-dialog"][open]');
  // 确认按钮默认获得焦点
  await page.screenshot({ path: path.join(outDir, '01-export-feedback-success.png') });
  console.log('✓ 截图已保存：01-export-feedback-success.png');
  await page.click('[data-testid="export-dialog-btn-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'));

  // 场景 2: 导出失败反馈弹窗 (桌面视口)
  console.log('==> 捕获场景 2: 导出失败反馈弹窗...');
  await page.evaluate(async () => {
    window.showDirectoryPicker = async () => {
      const err = new Error('模拟磁盘写入权限拒绝或系统锁定');
      err.name = 'NotAllowedError';
      throw err;
    };
  });
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="export-dialog"][open]');
  await page.screenshot({ path: path.join(outDir, '02-export-feedback-error.png') });
  console.log('✓ 截图已保存：02-export-feedback-error.png');
  await page.click('[data-testid="export-dialog-btn-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'));

  // 场景 3: 空正文拦截弹窗 (带有检查结果与确认按钮)
  console.log('==> 捕获场景 3: 空正文拦截弹窗...');
  await page.evaluate(() => {
    delete window.showDirectoryPicker;
    const state = window.__wetrim.getState();
    for (const b of state.session.snapshot.blocks) {
      if (b.included) {
        window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: b.id } });
      }
    }
  });
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="export-dialog"][open]');
  await page.screenshot({ path: path.join(outDir, '03-export-feedback-empty.png') });
  console.log('✓ 截图已保存：03-export-feedback-empty.png');
  await page.click('[data-testid="export-dialog-btn-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'));

  // 恢复所有块
  await page.evaluate(() => {
    const state = window.__wetrim.getState();
    for (const b of state.session.snapshot.blocks) {
      if (!b.included) {
        window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: b.id } });
      }
    }
  });

  // 场景 4: 未下载图片处理弹窗 (桌面端 1200x900)
  console.log('==> 捕获场景 4: 未下载图片处理弹窗 (桌面视口)...');
  const articleWithExternalImages = {
    kind: 'article',
    source: {
      title: '含外链与跨域受限图片的测试长文',
      account: '媒体资源测试专栏',
      publishedAt: '2026-10-12T12:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-images',
    },
    contentHtml: `
      <h1>多媒体与外链图片排查</h1>
      <p>段落一：含有跨站未授权图片。</p>
      <img src="https://external-forbidden.test/assets/diagram-architecture-2026-highres.png" alt="架构设计总图" />
      <p>段落二：含有多处引用的快捷图片定义与无效链接。</p>
      <img src="ftp://invalid-protocol.example.com/images/broken-resource.webp" alt="损坏协议资源" />
      <p>段落三：网络 403 访问受限资源展示。</p>
      <img src="https://thirdparty-cdn.test/restricted/private-token-protected-image.jpg" alt="受限资源" />
    `,
    unstable: false,
  };

  await page.evaluate(async (art) => {
    const snap = window.__wetrim.buildArticleSnapshot(art);
    window.__wetrim.dispatch({
      type: 'INIT_STORAGE_STATE',
      payload: {
        session: {
          schemaVersion: 1,
          sessionId: 'img-session-capture',
          revision: 1,
          savedAt: new Date().toISOString(),
          snapshot: snap,
        },
        candidateSnapshot: null,
        corrupted: false,
        isReadOnly: false,
      },
    });
  }, articleWithExternalImages);

  await page.waitForSelector('[data-view-mode="cleaning"]');
  // 模拟 showDirectoryPicker 并点击导出以唤起 UnlocalizedImagesDialog
  await page.evaluate(async () => {
    const rootDir = await navigator.storage.getDirectory();
    const target = await rootDir.getDirectoryHandle('export-target-images', { create: true });
    window.showDirectoryPicker = async () => target;
  });
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.screenshot({ path: path.join(outDir, '04-unlocalized-dialog-desktop.png') });
  console.log('✓ 截图已保存：04-unlocalized-dialog-desktop.png');

  // 场景 5: 未下载图片处理弹窗 (360px 窄屏移动视口)
  console.log('==> 捕获场景 5: 未下载图片处理弹窗 (360px 窄屏移动视口)...');
  await page.setViewport({ width: 360, height: 740 });
  await page.screenshot({ path: path.join(outDir, '05-unlocalized-dialog-mobile.png') });
  console.log('✓ 截图已保存：05-unlocalized-dialog-mobile.png');

  // 关闭未下载图片弹窗
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlocalized-dialog"]'));

  // 场景 6: 检查结果预览中的导出按钮与排版衔接 (桌面端)
  console.log('==> 捕获场景 6: 检查结果预览内的导出按钮与排版...');
  await page.setViewport({ width: 1200, height: 900 });
  await page.click('[data-testid="action-preview"]');
  await page.waitForSelector('[data-testid="preview-dialog"][open]');
  await page.screenshot({ path: path.join(outDir, '06-preview-dialog-export-ready.png') });
  console.log('✓ 截图已保存：06-preview-dialog-export-ready.png');
  await page.click('[data-testid="preview-btn-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]'));

  console.log('所有 6 张 Issue #76 视觉验证截图捕获完成！');
} catch (err) {
  console.error('截图失败:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
