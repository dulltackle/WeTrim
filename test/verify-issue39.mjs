import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox'],
});
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker')).worker();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${await worker.evaluate(() => chrome.runtime.id)}/app.html`);
  await page.waitForSelector('[data-view-mode="empty"]');
  await page.evaluate(() => window.__wetrim.processCaptureResult({
    kind: 'article',
    source: { title: '双击正文与单一编辑块', account: null, publishedAt: null, url: 'https://mp.weixin.qq.com/s/edit' },
    contentHtml: '<p><strong>Alpha</strong> 正文文字</p><p><strong>Beta</strong> 另一段文字</p>',
    unstable: false,
  }));
  const block = order => `[data-testid="block-item"][data-block-order="${order}"]`;
  const body = order => `${block(order)} [data-testid="block-rendered-content"]`;
  const editor = order => `${block(order)} textarea`;
  const action = (order, name) => `${block(order)} [data-testid="block-action-${name}"]`;
  const doubleClickText = async (selector, word) => {
    const el = await page.waitForSelector(selector);
    await el.scrollIntoView();
    const point = await el.evaluate((el, word) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf(word);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + word.length);
        const rect = range.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        if (!el.contains(document.elementFromPoint(x, y))) throw new Error(`双击目标被遮挡：${word} (${x}, ${y})`);
        return { x, y };
      }
      throw new Error(`找不到可双击文字：${word}`);
    }, word);
    await page.mouse.click(point.x, point.y, { count: 2 });
  };
  await page.waitForSelector(body(1));
  await page.click(`${body(1)} strong`, { count: 2 });
  await page.waitForSelector(editor(1));
  assert.equal(await page.$eval(editor(1), el => el.value), '**Alpha** 正文文字');
  assert(await page.$eval(editor(1), el => document.activeElement === el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length), '双击后聚焦源码末尾');
  await page.click(action(1, 'finish-edit'));
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, block(1));
  console.log('✓ 真实双击选词进入编辑，光标在末尾，主动完成焦点回到本块');

  await page.click(action(1, 'edit'));
  await page.type(editor(1), '未保存修改');
  await page.click(`${body(2)} strong`, { count: 2 });
  await page.waitForSelector(editor(2));
  assert.equal((await page.$$('[data-testid="block-editor-textarea"]')).length, 1, '双击另一块后只有一个编辑器');
  assert.equal(await page.$(editor(1)), null, '旧块被动退出');
  assert(await page.$eval(editor(2), el => document.activeElement === el), '被动退出不抢新块焦点');
  await page.waitForSelector('[data-save-status="saved"]');
  await page.reload();
  await page.waitForSelector(body(1));
  assert.match(await page.$eval(body(1), el => el.textContent), /未保存修改/, '切换编辑块前的修改已落盘，重载后可恢复');
  console.log('✓ 双击切换只保留一个编辑器，旧块未保存修改落盘，焦点归新块');

  // 按钮和键盘入口同样遵守单一编辑块；被动退出清理未完成的还原确认。
  await page.click(action(1, 'edit'));
  await page.click(`${block(1)} [data-testid="block-editor"] [data-testid="block-action-restore-content"]`);
  await page.click(action(2, 'edit'));
  assert.equal((await page.$$('textarea')).length, 1);
  assert.equal(await page.$(`${block(1)} [data-testid="restore-confirm-inline"]`), null);
  await page.focus(action(1, 'exclude'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert(await page.$eval(action(1, 'edit'), el => document.activeElement === el), 'Tab 可到达编辑按钮');
  await page.keyboard.press('Enter');
  assert.equal((await page.$$('textarea')).length, 1);
  assert(await page.$eval(editor(1), el => document.activeElement === el && el.selectionStart === el.value.length));
  assert.equal(await page.$(`${block(1)} [data-testid="restore-confirm-inline"]`), null, '重新进入编辑不恢复旧确认');
  await page.click(action(1, 'finish-edit'));
  console.log('✓ 按钮与 Tab + Enter 共用单一编辑约束，被动退出清除还原确认');

  const cases = [
    ['paragraph', '**Gamma** 段落', 'Gamma'],
    ['code', '```js\nconst value = 1;\n```', 'const'],
    ['table', '| Name | Value |\n| --- | --- |\n| Alpha | 1 |', 'Name'],
    ['list', '- **Delta** 列表', 'Delta'],
    ['quote', '> **Echo** 引用', 'Echo'],
    ['paragraph', '', null],
    ['divider', '---', null],
    ['image', '![插图](https://mmbiz.qpic.cn/issue39.png)', null],
    ['richMedia', '**Media** 信息', 'Media'],
    ['unknown', '**Unknown** 内容', 'Unknown'],
    ['formula', '**Formula** 内容', 'Formula'],
    ['heading', '# Heading', 'Heading'],
  ];
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://mmbiz.qpic.cn/issue39.png') void request.abort();
    else void request.continue();
  });
  await page.evaluate(cases => {
    const session = window.__wetrim.getState().session;
    window.__wetrim.dispatch({ type: 'SET_NEW_SESSION', payload: {
      ...session, revision: session.revision + 1,
      snapshot: { ...session.snapshot, blocks: cases.map(([type, markdown], i) => ({
        id: `case-${i}`, order: i + 1, type, initialMarkdown: markdown,
        editedMarkdown: i === 5 ? '' : null, included: i !== 4,
        originalHtml: '', notes: i === 3 ? [{ code: 'unknown-content', message: '转换提示文字' }] : [],
      })) },
    } });
  }, cases);
  await page.waitForSelector('[data-block-id="case-0"]');

  // 没有选中文本、以及选区来自别的块时，都不能把旧选区当作本次双击。
  await page.$eval(body(1), el => {
    getSelection().removeAllRanges();
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-block-order="2"] code'));
    getSelection().addRange(range);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  assert.equal((await page.$$('textarea')).length, 0);

  for (const name of ['block-order-badge', 'block-type-badge', 'block-status-tag', 'block-notes', 'composite-block-tip']) {
    await page.click(`${block(4)} [data-testid="${name}"]`, { count: 2 });
    assert.equal((await page.$$('textarea')).length, 0, `${name} 不触发编辑`);
  }
  await page.click(`${block(5)} [data-testid="block-summary-preview"]`, { count: 2 });
  assert.equal((await page.$$('textarea')).length, 0, '折叠摘要不编辑');
  await page.click(action(5, 'expand'));
  await doubleClickText(body(5), 'Echo');
  assert.equal(await page.$eval(block(5), el => el.dataset.blockIncluded), 'false');
  await page.click(action(5, 'finish-edit'));
  await page.click(`${block(6)} [data-testid="block-empty-placeholder"]`, { count: 2 });
  assert.equal(await page.$eval(editor(6), el => el.value), '');
  await page.click(action(6, 'finish-edit'));
  await page.click(`${body(7)} hr`, { count: 2 });
  await page.waitForSelector(`${block(8)} [data-testid="image-error-card"]`);
  await page.click(`${block(8)} [data-testid="image-error-card"]`, { count: 2 });
  assert.equal((await page.$$('textarea')).length, 0, '分割线及图片辅助文字不触发编辑');
  console.log('✓ 空选区、跨块选区、徽章、提示、折叠摘要和图片辅助信息均不误触；空块与剔除展开块可编辑');

  for (let i = 0; i < cases.length; i++) {
    if (!cases[i][2] || i === 4) continue;
    await doubleClickText(body(i + 1), cases[i][2]);
    await page.waitForSelector(editor(i + 1));
    assert.equal(await page.$eval(editor(i + 1), el => el.value), cases[i][1]);
    assert.equal((await page.$$('textarea')).length, 1);
    await page.click(action(i + 1, 'finish-edit'));
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, block(i + 1));
  }
  // 初始类型是图片也可以被用户改写成文字，不按类型封锁双击入口。
  await page.click(action(8, 'edit'));
  await page.focus(editor(8));
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.type(editor(8), '**ImageText**');
  await page.click(action(8, 'finish-edit'));
  await doubleClickText(body(8), 'ImageText');
  assert.equal(await page.$eval(block(8), el => el.dataset.blockType), 'image');
  await page.click(action(8, 'finish-edit'));
  console.log('✓ 代码、表格及其余正文一视同仁，初始图片类型改为文字后也可双击');

  const style = await page.$eval(body(1), el => ({ cursor: getComputedStyle(el).cursor, background: getComputedStyle(el).backgroundColor }));
  await page.hover(body(1));
  assert.deepEqual(await page.$eval(body(1), el => ({ cursor: getComputedStyle(el).cursor, background: getComputedStyle(el).backgroundColor })), style);
  assert.equal(style.cursor, 'text');
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'wetrim-issue39-'));
  await page.screenshot({ path: path.join(artifacts, 'reading.png') });
  await doubleClickText(body(1), 'Gamma');
  await page.screenshot({ path: path.join(artifacts, 'editing.png') });
  await page.click(action(1, 'finish-edit'));
  console.log(`✓ 正文 text 光标，无 hover 背景变化；截图：${artifacts}`);

  // BlockList 公开的图片引用定位入口也必须结束旧编辑；再次用普通入口打开时恢复末尾光标。
  await page.click(action(1, 'edit'));
  await page.type(editor(1), '待提交');
  await page.evaluate(() => window.__wetrim.blockListRef.current.editImageReference({
    blockId: 'case-7', order: 8, summary: '图片引用', start: 2, end: 11,
  }));
  await page.waitForSelector(editor(8));
  assert.equal((await page.$$('textarea')).length, 1);
  assert.equal(await page.$eval(editor(8), el => el.value.slice(el.selectionStart, el.selectionEnd)), 'ImageText');
  await page.click(action(1, 'edit'));
  await page.click(action(8, 'edit'));
  assert(await page.$eval(editor(8), el => el.selectionStart === el.value.length && el.selectionEnd === el.value.length));
  await page.click(action(8, 'finish-edit'));
  console.log('✓ 图片引用定位共用编辑约束，普通入口不会残留图片选区');

  await page.click(action(5, 'collapse'));
  await page.evaluate(() => window.__wetrim.blockListRef.current.editImageReference({
    blockId: 'case-4', order: 5, summary: '引用中的定位', start: 4, end: 8,
  }));
  await page.waitForSelector(editor(5));
  assert.equal(await page.$eval(editor(5), el => el.value.slice(el.selectionStart, el.selectionEnd)), 'Echo', '定位折叠块时，先展开再设置选区');
  assert.equal(await page.$eval(block(5), el => el.dataset.blockIncluded), 'false');
  await page.click(action(5, 'finish-edit'));

  // 使用 600 块长文测量；从操作开始计时，等待真实 DOM 更新并跨过一次绘制机会。
  await page.evaluate(() => {
    const session = window.__wetrim.getState().session;
    window.__wetrim.dispatch({ type: 'SET_NEW_SESSION', payload: {
      ...session, revision: session.revision + 1,
      snapshot: { ...session.snapshot, blocks: Array.from({ length: 600 }, (_, i) => ({
        id: `perf-${i}`, order: i + 1, type: 'paragraph', originalHtml: '',
        initialMarkdown: `**段落${i + 1}** ${'用于验证逐块清洗的编辑响应速度。'.repeat(4)}`,
        editedMarkdown: null, included: true, notes: [],
      })) },
    } });
  });
  await page.waitForSelector('[data-block-id="perf-0"]');
  await page.waitForSelector('[data-save-status="saved"]');
  await (await page.$(block(1))).scrollIntoView();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const timings = await page.evaluate(async () => {
    const root = document.querySelector('[data-block-id="perf-0"]');
    const measure = async open => {
      const start = performance.now();
      root.querySelector(`[data-testid="block-action-${open ? 'edit' : 'finish-edit'}"]`).click();
      while (Boolean(root.querySelector('textarea')) !== open) {
        if (performance.now() - start > 3000) throw new Error('编辑器未响应');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      root.getBoundingClientRect();
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now() - start;
    };
    const rounds = [];
    for (let i = 0; i < 3; i++) rounds.push({ open: await measure(true), close: await measure(false) });
    return rounds;
  });
  console.log('600 块 / 4× CPU 开关编辑器耗时（ms）：', JSON.stringify(timings));
  for (const round of timings) {
    assert(round.open <= 100, `打开编辑器 ${round.open} ms 超过 100 ms`);
    assert(round.close <= 100, `关闭编辑器 ${round.close} ms 超过 100 ms`);
  }
  console.log('✓ 600 块长文在 4× CPU 降速下，三轮开关编辑器均 ≤ 100 ms');
} finally {
  await browser.close();
}
