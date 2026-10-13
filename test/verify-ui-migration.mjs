import assert from 'node:assert/strict';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

// 验证可见布局、正文语义和真实点击/键盘交互，不依赖工具类或组件内部结构。
const browser = await launchChrome({
  headless: true,
  enableExtensions: [path.resolve('dist')],
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'));
  const worker = await target.worker();
  const id = await worker.evaluate(() => chrome.runtime.id);
  await worker.evaluate(() => chrome.storage.local.clear());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://example.test/illustration.svg') {
      void request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="blue"/></svg>',
      });
    } else {
      void request.continue();
    }
  });
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForSelector('[data-view-mode="empty"]');
  assert.equal(await page.$eval('.rendered-steps ol', el => getComputedStyle(el).listStyleType), 'decimal', '三步指引必须显示编号');
  await page.evaluate(() => window.__wetrim.processCaptureResult({
    kind: 'article',
    source: { title: '列表与原图回归', url: 'https://example.test/article' },
    contentHtml: '<ol start="3"><li>步骤三<ul><li>嵌套项目</li></ul></li><li>步骤四</li></ol>' +
      '<ul><li>项目甲<ol><li>嵌套步骤</li></ol></li><li>项目乙</li></ul>' +
      '<p>插图</p><img src="https://example.test/illustration.svg" alt="回归插图">',
    unstable: false,
  }));
  await page.waitForSelector('[data-view-mode="cleaning"]');
  await page.waitForSelector('[data-save-status="saved"]');

  const checkLists = async selector => {
    const lists = await page.$$eval(`${selector} ol, ${selector} ul`, elements => elements.map(el => ({
      tag: el.tagName,
      style: getComputedStyle(el).listStyleType,
      start: el.getAttribute('start'),
    })));
    assert.equal(lists.length, 4, '正文必须保留内外层有序、无序列表');
    for (const list of lists) assert.equal(list.style, list.tag === 'OL' ? 'decimal' : 'disc');
    assert.equal(lists[0].start, '3', '有序列表起始值必须保留');
  };
  await checkLists('[data-testid="block-items-stream"]');
  const toolbarButton = await page.$eval('[data-testid="action-preview"]', el => {
    const style = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, padding: parseFloat(style.paddingLeft), fontSize: parseFloat(style.fontSize) };
  });
  assert.deepEqual(toolbarButton, { height: 28, padding: 12, fontSize: 12 }, '工具栏尺寸必须由新版控件控制');

  const preview = '[data-testid="preview-dialog"]';
  const thumb = `${preview} [data-testid="image-thumbnail-box"]`;
  const viewer = '[data-testid="image-viewer-overlay"]';
  const close = '[data-testid="image-viewer-close-btn"]';
  await page.click('[data-testid="action-preview"]');
  await page.waitForSelector(`${preview}[open]`);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-image-status') === 'loaded', {}, `${preview} [data-testid="image-presentation"]`);
  await checkLists('[data-testid="preview-article-content"]');

  for (const width of [1200, 360]) {
    await page.setViewport({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.$eval(preview, el => {
      const rect = el.getBoundingClientRect();
      const header = getComputedStyle(el.querySelector('.preview-dialog-header'));
      const body = getComputedStyle(el.querySelector('[data-testid="preview-dialog-body"]'));
      return {
        centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2,
        headerPadding: parseFloat(header.paddingLeft), bodyPadding: parseFloat(body.paddingLeft),
        overflow: el.scrollWidth > el.clientWidth,
      };
    });
    assert(Math.abs(geometry.centerX - width / 2) < 1, '预览必须水平居中');
    assert(Math.abs(geometry.centerY - 450) < 1, '预览必须垂直居中');
    assert(geometry.headerPadding >= 16 && geometry.bodyPadding >= 20, '预览必须保留标题和正文留白');
    assert.equal(geometry.overflow, false, '窄窗口不能横向溢出');

    for (const method of ['button', 'escape', 'outside']) {
      await page.focus(thumb);
      await page.keyboard.press('Enter');
      await page.waitForSelector(viewer);
      await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, close);
      const viewerGeometry = await page.$eval(viewer, el => {
        const rect = el.getBoundingClientRect();
        const button = el.querySelector('[data-testid="image-viewer-close-btn"]');
        const buttonRect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clickable: button === hit || button.contains(hit) };
      });
      assert.deepEqual(viewerGeometry, { x: 0, y: 0, width, height: 900, clickable: true }, '原图必须覆盖视口且关闭按钮可点击');
      await page.keyboard.press('Tab');
      await page.waitForFunction(selector => document.querySelector(selector)?.contains(document.activeElement), {}, viewer);
      if (method === 'button') await page.click(close);
      else if (method === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(width - 10, 890);
      await page.waitForSelector(viewer, { hidden: true });
      await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, thumb);
      assert(await page.$eval(preview, el => el.open), '关闭原图不能关闭预览');
    }
    console.log(`✓ ${width}px：预览居中和留白、原图全屏/焦点捕获/三种关闭方式/焦点恢复`);
  }
  await page.click('[data-testid="preview-tab-source"]');
  const markdown = await page.$eval('[data-testid="preview-source-pre"]', el => el.textContent);
  assert(markdown.includes('3.  步骤三') || /3\.\s+步骤三/.test(markdown), '列表编号必须保留在 Markdown 中');
  assert(markdown.includes('https://example.test/illustration.svg'), '原图地址必须保留');
  assert(!markdown.includes('block-rendered-content'), '应用排版不能写入 Markdown');
  assert(!markdown.includes('my-1.5') && !markdown.includes('list-decimal'), '呈现节点的排版工具类不能写入 Markdown');
  assert(await page.evaluate(() => window.__wetrim.getState().session.snapshot.blocks.every(block =>
    !block.originalHtml.includes('my-1.5') && !block.originalHtml.includes('list-decimal')
  )), '呈现排版不能改写原始文章块');
  await page.keyboard.press('Escape');
  await page.waitForSelector(preview, { hidden: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'action-preview');
  assert.deepEqual(errors, [], '新弹窗不能产生浏览器运行错误');
  console.log('✓ 正文、嵌套列表、三步指引、Markdown 内容边界及预览关闭焦点');
} finally {
  await browser.close();
}
