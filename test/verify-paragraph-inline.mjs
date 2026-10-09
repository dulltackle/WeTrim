import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

// 默认重放用户保存页面中的原始段落；也可传入整页 HTML 验证原场景。
const html = fs.readFileSync(process.argv[2] || 'test/fixtures/paragraph-inline.html', 'utf8');
const browser = await launchChrome({ headless: true, enableExtensions: [path.resolve('dist')], args: ['--no-sandbox'] });
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`chrome-extension://${new URL(target.url()).host}/app.html`);
  await page.waitForFunction(() => !!window.__wetrim?.buildArticleSnapshot);
  const result = await page.evaluate(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const content = doc.querySelector('#js_content') || doc.body;
    const paragraph = [...content.querySelectorAll('p')].find(p => p.textContent.startsWith('疼痛科医生工作的每一天'));
    const capture = contentHtml => ({ kind: 'article', source: { title: '段落回归', url: 'https://mp.weixin.qq.com/s/8MDwL05k0evWDb0FTyV6Vg', account: '' }, contentHtml, unstable: false });
    const snapshot = window.__wetrim.buildArticleSnapshot(capture(content.innerHTML));
    const isolated = window.__wetrim.buildArticleSnapshot(capture(paragraph?.outerHTML || '')).blocks;
    return { text: paragraph?.textContent, blocks: snapshot.blocks, isolated };
  }, html);
  assert.ok(result.text, '必须找到原始目标段落');
  assert.equal(result.isolated.length, 1, '原文段落应为一块，不能按 font 拆成 12 块');
  const targetBlock = result.blocks.find(b => b.initialMarkdown.includes('疼痛科医生工作的每一天'));
  assert.ok(targetBlock, '整篇切分后应保留目标段落');
  assert.equal(targetBlock.type, 'paragraph');
  const rendered = await page.evaluate(block => {
    const { dispatch } = window.__wetrim;
    dispatch({ type: 'SET_NEW_SESSION', payload: {
      schemaVersion: 1, sessionId: 'paragraph-inline', revision: 1, savedAt: new Date().toISOString(),
      snapshot: { snapshotId: 'paragraph-inline', capturedAt: new Date().toISOString(), source: { title: '段落回归', url: 'https://mp.weixin.qq.com/s/test' }, blocks: [block], images: [], captureWarnings: [] },
    } });
    return block.initialMarkdown;
  }, targetBlock);
  assert.equal(rendered.replace(/\*/g, ''), result.text, '段落文字必须完整且顺序不变');
  await page.waitForSelector('[data-testid="block-item"]');
  const view = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="block-item"]');
    return { count: document.querySelectorAll('[data-testid="block-item"]').length,
      bold: [...block.querySelectorAll('strong')].map(el => el.textContent).join('') };
  });
  assert.equal(view.count, 1, '清洗视图应只显示一个段落块');
  assert.equal(view.bold, '打针治疗', '原文强调必须保留');
  console.log('✓ 原始段落：完整保留为一块，打针治疗仍为粗体');

  const cases = [
    ['最小复现', '<p><font>前文</font>后文</p>', ['paragraph'], ['前文后文']],
    ['相邻行内节点', '<p><font>前文</font><b><font>重点</font></b><font>后文</font></p>', ['paragraph'], ['前文**重点**后文']],
    ['相邻粗体与链接', '<p><b>甲</b><strong><a href="https://example.com/">乙</a></strong><b>丙</b></p>', ['paragraph'], ['**甲[乙](https://example.com/)丙**']],
    ['粗体间空格保留', '<p><b>甲</b> <b>乙</b></p>', ['paragraph'], ['**甲** **乙**']],
    ['粗体间普通文字保留', '<p><b>甲</b>中间<b>乙</b></p>', ['paragraph'], ['**甲**中间**乙**']],
    ['独立段落', '<section><p><font>甲</font></p><p><font>乙</font></p></section>', ['paragraph', 'paragraph'], ['甲', '乙']],
    ['font 包裹块级容器', '<font><div>甲</div><div>乙</div></font>', ['paragraph', 'paragraph'], ['甲', '乙']],
    ['图片独立取舍', '<p><font>甲<img src="https://example.com/a.png">乙</font></p>', ['paragraph', 'image', 'paragraph']],
    ['列表整体成块', '<ul><li><font>甲</font></li><li><font>乙</font></li></ul>', ['list']],
    ['引用整体成块', '<blockquote><p><font>甲</font></p><p><font>乙</font></p></blockquote>', ['quote']],
  ];
  for (const [name, contentHtml, types, markdown] of cases) {
    const blocks = await page.evaluate(contentHtml => window.__wetrim.buildArticleSnapshot({ kind: 'article', source: { title: '边界回归', url: 'https://mp.weixin.qq.com/s/test' }, contentHtml, unstable: false }).blocks, contentHtml);
    assert.deepEqual(blocks.map(b => b.type), types, name);
    if (markdown) assert.deepEqual(blocks.map(b => b.initialMarkdown), markdown, name);
    if (name === '图片独立取舍') assert.deepEqual([blocks[0].initialMarkdown, blocks[2].initialMarkdown], ['甲', '乙']);
    console.log(`✓ ${name}`);
  }
} finally { await browser.close(); }
