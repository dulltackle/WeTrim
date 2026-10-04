import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox'],
});
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker')).worker();
  const appUrl = `chrome-extension://${await worker.evaluate(() => chrome.runtime.id)}/app.html`;
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(appUrl);
  await page.waitForSelector('[data-view-mode="empty"]');
  await page.evaluate(() => window.__wetrim.processCaptureResult({
    kind: 'article',
    source: { title: '正文链接', account: null, publishedAt: null, url: 'https://mp.weixin.qq.com/s/links' },
    contentHtml: '<p><a href="#article-link"><strong>链接文字</strong></a></p>',
    unstable: false,
  }));
  const content = '[data-testid="block-rendered-content"]';
  const link = `${content} a`;
  await page.waitForSelector(link);
  await page.click(`${link} strong`);
  assert.equal(page.url(), appUrl, '单击正文链接内的文字不得触发导航');
  assert.equal(await page.$eval(link, el => el.getAttribute('href')), 'https://mp.weixin.qq.com/s/links#article-link', '保留转换后的正文链接地址');
  console.log('✓ 单击嵌套文字不导航，正文链接地址保留');

  const tabCount = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  await page.click(`${link} strong`, { button: 'middle' });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({})).length), tabCount, '中键不得打开正文链接');
  console.log('✓ 中键不打开新标签页');

  await page.keyboard.down('Control');
  try { await page.click(`${link} strong`); }
  finally { await page.keyboard.up('Control'); }
  await page.focus(link);
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(page.url(), appUrl, '键盘激活不导航');
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({})).length), tabCount, 'Ctrl 单击不打开新标签页');

  // 只验证 #38 的事件可达与不导航；是否进入编辑由 #39 的原生非空选区条件决定。
  await page.$eval(content, el => {
    el.addEventListener('dblclick', () => {
      el.closest('[data-testid="block-item"]').dataset.doubleClicked = 'true';
    }, { once: true });
  });
  await page.click(`${link} strong`, { count: 2 });
  assert.equal(page.url(), appUrl, '双击期间不导航');
  assert.equal(await page.$eval('[data-testid="block-item"]', el => el.dataset.doubleClicked), 'true', '双击事件仍可到达正文');
  console.log('✓ Ctrl 单击与 Enter 不导航，双击事件正常到达正文');

  const markdown = '[**链接文字**](https://mp.weixin.qq.com/s/links#article-link)';
  if (!(await page.$('[data-testid="block-editor-textarea"]'))) {
    await page.click('[data-testid="block-action-edit"]');
  }
  await page.waitForSelector('[data-testid="block-editor-textarea"]');
  assert.equal(await page.$eval('[data-testid="block-editor-textarea"]', el => el.value), markdown, '原链接 Markdown 保留');
  await page.click('[data-testid="block-action-finish-edit"]');
  await page.click('[data-testid="block-action-exclude"]');
  await page.click('[data-testid="block-action-expand"]');
  await page.click(`${link} strong`);
  assert.equal(page.url(), appUrl, '剔除后展开的正文也不导航');
  assert.equal(await page.$eval('[data-testid="block-item"]', el => el.dataset.blockIncluded), 'false');
  await page.click('[data-testid="block-action-restore"]');
  console.log('✓ 编辑按钮、完成编辑和取舍正常，链接 Markdown 原样保留');

  // 经编辑入口覆盖含图的 React 渲染路径，并确认图片查看功能仍可用。
  const icon = await fs.readFile('public/icons/icon-48.png');
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://mmbiz.qpic.cn/issue38.png') {
      void request.respond({ status: 200, contentType: 'image/png', body: icon });
    } else void request.continue();
  });
  const imageMarkdown = '- [**含图链接** ![图片](https://mmbiz.qpic.cn/issue38.png)](https://example.com/article)';
  await page.click('[data-testid="block-action-edit"]');
  const editor = '[data-testid="block-editor-textarea"]';
  await page.focus(editor);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.type(editor, imageMarkdown);
  await page.click('[data-testid="block-action-finish-edit"]');
  await page.waitForSelector('[data-image-status="loaded"]');
  await page.click(`${link} strong`);
  await page.click('[data-testid="image-thumbnail-img"]');
  await page.waitForSelector('[data-testid="image-viewer-overlay"][open]');
  assert.equal(page.url(), appUrl, '含图链接不导航，点击图片仍打开查看浮层');
  await page.click('[data-testid="image-viewer-close-btn"]');
  await page.click('[data-testid="block-action-edit"]');
  assert.equal(await page.$eval(editor, el => el.value), imageMarkdown, '含图链接源码未被更改');
  console.log('✓ 含图渲染路径不导航，图片查看与链接源码保留正常');
} finally {
  await browser.close();
}
