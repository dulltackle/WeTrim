import { launchChrome } from '../test/chrome.mjs';
import { feishuFixture } from '../test/feishu-fixture.mjs';
import path from 'path';
import fs from 'fs';

const distDir = path.resolve('dist');
const browser = await launchChrome({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  enableExtensions: [distDir],
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const outDir = path.resolve('artifacts/issue77');
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

  const server = feishuFixture();
  server.fields[6].property = {
    options: [
      { name: '技术架构' },
      { name: '前端工程' },
      { name: '产品设计' },
      { name: '最佳实践' },
    ],
  };
  await server.install(page);

  await worker.evaluate(() => chrome.storage.local.clear());
  await page.goto(appUrl);
  await page.waitForSelector('[data-view-mode="empty"]');
  await server.seed(page);

  // 写入基础文章
  const sampleArticle = {
    kind: 'article',
    source: {
      title: '飞书文档多维表格保存与标签管理指南',
      account: '效率工程工具团队',
      publishedAt: '2026-10-12T14:00:00.000Z',
      url: 'https://mp.weixin.qq.com/s/sample-feishu',
    },
    contentHtml: '<h1>飞书保存操作</h1><p>正文内容测试</p><p><img src="https://mmbiz.qpic.cn/sample-a.png"></p>',
    unstable: false,
  };

  await page.evaluate((art) => window.__wetrim.processCaptureResult(art), sampleArticle);
  await page.waitForSelector('[data-feishu-save]');

  // 场景 1: 飞书保存面板 (桌面端 1200x900)
  console.log('==> 捕获场景 1: 飞书保存面板 (桌面端)...');
  await page.screenshot({ path: path.join(outDir, '01-feishu-save-panel-desktop.png') });
  console.log('✓ 截图已保存：01-feishu-save-panel-desktop.png');

  // 场景 2: 标签选择器展开 (读取选项并展示已有标签)
  console.log('==> 捕获场景 2: 标签选择器展开...');
  await page.click('[data-feishu-tags-open]');
  await page.waitForSelector('[data-feishu-tags-search]');
  await page.screenshot({ path: path.join(outDir, '02-tag-picker-expanded-desktop.png') });
  console.log('✓ 截图已保存：02-tag-picker-expanded-desktop.png');

  // 场景 3: 搜索已有标签筛选
  console.log('==> 捕获场景 3: 标签搜索筛选...');
  await page.type('[data-feishu-tags-search]', '前端');
  await page.screenshot({ path: path.join(outDir, '03-tag-picker-search-filter.png') });
  console.log('✓ 截图已保存：03-tag-picker-search-filter.png');

  // 场景 4: 勾选并添加新标签应用
  console.log('==> 捕获场景 4: 标签应用状态...');
  const checkbox = await page.$('input[name="article-tag"][value="前端工程"]');
  if (checkbox) await checkbox.click();
  await page.type('[data-feishu-tags-new]', '深度重构');
  await page.click('[data-feishu-tags-add]');
  await page.click('[data-feishu-tags-apply]');
  await page.waitForFunction(() => !document.querySelector('[data-feishu-tags-search]'));
  await page.screenshot({ path: path.join(outDir, '04-tag-picker-draft-applied.png') });
  console.log('✓ 截图已保存：04-tag-picker-draft-applied.png');

  // 场景 5: 360px 窄屏移动视口下的标签选择器
  console.log('==> 捕获场景 5: 360px 窄屏移动端标签选择器...');
  await page.setViewport({ width: 360, height: 740 });
  await page.click('[data-feishu-tags-open]');
  await page.waitForSelector('[data-feishu-tags-search]');
  await page.screenshot({ path: path.join(outDir, '05-tag-picker-mobile-360px.png') });
  console.log('✓ 截图已保存：05-tag-picker-mobile-360px.png');
  await page.click('[data-feishu-tags-cancel]');

  // 场景 6: 恢复卡片与另存二次确认
  console.log('==> 捕获场景 6: 恢复卡片与另存二次确认...');
  await page.setViewport({ width: 1200, height: 900 });
  server.imageFault = 'uploadReject';
  await page.click('[data-feishu-save]');
  await page.waitForFunction(() =>
    document.querySelector('[data-feishu-save-status]')?.textContent.includes('飞书拒绝')
  );
  await page.waitForSelector('[data-feishu-copy-recovery]');
  await page.click('[data-feishu-copy-recovery]');
  await page.waitForSelector('[data-feishu-copy-confirm]');
  await page.screenshot({ path: path.join(outDir, '06-feishu-recovery-confirm.png') });
  console.log('✓ 截图已保存：06-feishu-recovery-confirm.png');

  console.log('所有 6 张 Issue #77 视觉验证截图捕获完成！');
} catch (err) {
  console.error('截图失败:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
