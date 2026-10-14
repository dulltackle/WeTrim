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

const outDir = path.resolve('artifacts/issue75');
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

  const sampleArticle = {
    kind: 'article',
    source: {
      title: '排版清样与设计系统迁移指南',
      account: 'WeTrim 研发团队',
      publishedAt: '2026-10-12T10:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-preview-article',
    },
    contentHtml: `
      <h1>设计系统重构概述</h1>
      <p>本期重构全面引入 Tailwind CSS 与 shadcn/ui 组件库，统一界面底色为 <code>sheet-bg</code>，同时将重点交互强调色收敛至朱红与普鲁士蓝。</p>
      <table>
        <tr><th colspan="2">跨列合并单元格（触发降级转换）</th></tr>
        <tr><td>检查结果</td><td>原生 Dialog + Tailwind (≤ 300 ms)</td></tr>
      </table>
      <p>检查结果对话框作为交付前的最终成稿清样，采用纸张底色与单栏连续排版，去除全部编辑与取舍标记。</p>
      <p>源码视图支持 YAML front-matter 预览与完整正文 Markdown 查看，满足专业导出需求。</p>
    `,
    unstable: false,
  };

  await worker.evaluate(() => chrome.storage.local.clear());
  await page.goto(appUrl);
  await page.waitForSelector('[data-view-mode="empty"]');

  // 1. 注入文章并转入清洗模式
  await page.evaluate((art) => window.__wetrim.processCaptureResult(art), sampleArticle);
  await page.waitForSelector('[data-view-mode="cleaning"]');
  await page.waitForSelector('[data-save-status="saved"]');

  // 打开预览对话框
  await page.click('[data-testid="action-preview"]');
  await page.waitForSelector('[data-testid="preview-dialog"][open]');
  await page.waitForSelector('[data-testid="preview-panel-reading"]:not(.hidden)');

  // 截图 01: 宽屏阅读预览态
  await page.screenshot({
    path: path.join(outDir, '01-preview-reading-desktop.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：01-preview-reading-desktop.png');

  // 截图 02: 切换到 Markdown 源码预览态
  await page.click('[data-testid="preview-tab-source"]');
  await page.waitForSelector('[data-testid="preview-panel-source"]:not(.hidden)');
  await page.screenshot({
    path: path.join(outDir, '02-preview-source-desktop.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：02-preview-source-desktop.png');

  // 截图 03: 切换回阅读视图并展开降级汇总条
  await page.click('[data-testid="preview-tab-reading"]');
  await page.waitForSelector('[data-testid="preview-panel-reading"]:not(.hidden)');
  const degradationToggle = await page.waitForSelector('[data-testid="degradation-summary-toggle"]');
  await degradationToggle.click();
  await page.waitForSelector('[data-testid="degradation-items-list"]');
  await page.screenshot({
    path: path.join(outDir, '03-preview-degradation-expanded.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：03-preview-degradation-expanded.png');

  // 关闭对话框准备空态
  await page.click('[data-testid="preview-btn-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

  // 剔除所有块以制造全剔除空态
  await page.evaluate(() => {
    const blocks = document.querySelectorAll('[data-testid="block-item"]');
    for (const b of blocks) {
      const btn = b.querySelector('[data-testid="block-action-exclude"]');
      if (btn) btn.click();
    }
  });
  await page.waitForSelector('[data-save-status="saved"]');

  // 打开预览对话框触发空态引导
  await page.click('[data-testid="action-preview"]');
  await page.waitForSelector('[data-testid="preview-empty-state"]');
  await page.screenshot({
    path: path.join(outDir, '04-preview-empty-state.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：04-preview-empty-state.png');

  // 恢复排除的块：点击找回后界面处于 excluded 筛选，遍历恢复所有块并切回 all
  await page.click('[data-testid="preview-btn-recover-excluded"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
  await page.evaluate(() => {
    const restoreBtns = document.querySelectorAll('[data-testid="block-action-restore"]');
    for (const btn of restoreBtns) {
      btn.click();
    }
  });
  await page.click('[data-testid="filter-tab-all"]');
  await page.waitForSelector('[data-save-status="saved"]');

  // 重新打开预览并在移动端 360px 窄屏下截屏
  await page.click('[data-testid="action-preview"]');
  await page.waitForSelector('[data-testid="preview-dialog"][open]');
  await page.setViewport({ width: 360, height: 800 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({
    path: path.join(outDir, '05-preview-dialog-mobile.png'),
    fullPage: false,
  });
  console.log('✓ 截图已保存：05-preview-dialog-mobile.png');

  console.log('所有 5 张 Issue #75 视觉验证截图捕获完成！');
} finally {
  await browser.close();
}
