import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'wetrim-issue35-'));
const errors = [];
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const worker = await target.worker();
  const url = `chrome-extension://${await worker.evaluate(() => chrome.runtime.id)}/app.html`;
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(5000);
  await page.setViewport({ width: 1200, height: 900 });
  const article = { kind: 'article', source: { title: '新文章', account: null, publishedAt: null,
    url: 'https://mp.weixin.qq.com/s/recovery' }, contentHtml: '<p>不可覆盖上次进度</p>', unstable: false };
  // 使用真实转换、取舍与编辑操作得到 v1 样本，不构造不存在的旧版本。
  await worker.evaluate(() => chrome.storage.local.clear());
  await page.goto(url);
  await page.waitForSelector('[data-view-mode="empty"]');
  await page.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  await page.waitForSelector('[data-save-status="saved"]');
  await page.click('[data-testid="block-action-exclude"]');
  await page.waitForSelector('[data-save-status="saved"]');
  const valid = await worker.evaluate(async () => (await chrome.storage.local.get('currentSession')).currentSession);
  valid.snapshot.blocks[0].editedMarkdown = '';
  const seed = async raw => {
    await worker.evaluate(raw => chrome.storage.local.set({ currentSession: raw }), raw);
    await page.reload();
    await page.waitForSelector('[data-recovery-kind="unrecognized"], [data-view-mode="cleaning"]');
  };
  const stored = () => worker.evaluate(async () => (await chrome.storage.local.get('currentSession')).currentSession);
  const click = async text => {
    const button = await page.waitForSelector(`::-p-aria([name="${text}"][role="button"])`);
    await button.click();
  };
  const raw = { schemaVersion: 99, snapshot: { notes: ['原始记录', '<不可改写>'] }, custom: false };
  await seed(raw);
  await page.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  assert.deepEqual(await stored(), raw);
  assert.equal(await page.$('[data-testid="action-export"]'), null);
  assert.equal(await page.$('[data-testid="save-status"]'), null);
  await page.waitForFunction(() => document.body.textContent.includes('请先处理上次进度'));
  console.log('✓ 无法识别的格式保留原记录；新文章不会覆盖，不展示清洗、导出或已保存');

  // 下载真实文件，并与读取到的原记录比较（包含未知字段）。
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts });
  await click('下载原始备份');
  let backup;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { backup = await fs.readFile(path.join(artifacts, 'WeTrim-原始进度备份.json'), 'utf8'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.deepEqual(JSON.parse(backup), raw);
  assert.match(await page.$eval('.recovery-panel', el => el.textContent), /仅供排查，目前不能导入恢复/);
  assert.match(await page.$eval('.recovery-panel', el => el.textContent), /已发起下载/);
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  await page.setViewport({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const layout = await page.$$eval('.recovery-actions button', buttons => buttons.map(b => {
    const { x, y, width } = b.getBoundingClientRect(); return { x, y, width };
  }));
  assert.equal(layout[0].x, layout[1].x);
  assert(layout[1].y > layout[0].y);
  await page.screenshot({ path: path.join(artifacts, 'narrow.png'), fullPage: true });
  console.log('✓ 实际下载 JSON 忠实保留原记录；360px 无横向溢出且按钮纵向排列');

  await click('暂不处理');
  assert.match(await page.$eval('.recovery-panel', el => el.textContent), /未清除原记录/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'recovery-title');
  await page.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  assert.deepEqual(await stored(), raw);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '继续处理');
  await page.keyboard.press('Enter');
  await click('清除并重新开始');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('dialog[open]'), null);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '清除并重新开始');
  assert.deepEqual(await stored(), raw);
  console.log('✓ 暂不处理保留数据并可键盘继续；清除默认取消、Esc 取消且焦点返回');

  // 在系统存储边界注入删除失败；界面必须留在恢复页。
  await page.evaluate(() => {
    window.originalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
    chrome.storage.local.remove = async keys => {
      if ([keys].flat().includes('currentSession')) throw new Error('测试：删除失败');
      return window.originalRemove(keys);
    };
  });
  await click('清除并重新开始');
  await click('确认清除');
  await page.waitForFunction(() => document.body.textContent.includes('清除未完成'));
  assert.deepEqual(await stored(), raw);
  assert.equal(await page.$('[data-testid="empty-state-view"]'), null);
  await page.evaluate(() => { chrome.storage.local.remove = window.originalRemove; });
  // 不下载备份也可确认清除；清除在途期间抓取不应被提升。
  await page.reload();
  await page.waitForSelector('[data-recovery-kind="unrecognized"]');
  await page.evaluate(() => {
    const remove = chrome.storage.local.remove.bind(chrome.storage.local);
    chrome.storage.local.remove = async keys => {
      if ([keys].flat().includes('currentSession')) await new Promise(resolve => { window.finishClear = resolve; });
      return remove(keys);
    };
  });
  await click('清除并重新开始');
  await click('确认清除');
  await page.waitForFunction(() => typeof window.finishClear === 'function');
  assert.equal(await page.$$eval('dialog button', buttons => buttons.every(b => b.disabled)), true);
  await worker.evaluate(article => chrome.storage.local.set({ pendingCapture: { capturedAt: new Date().toISOString(), result: article } }), article);
  await page.evaluate(() => window.finishClear());
  await page.waitForSelector('[data-testid="empty-state-view"]');
  assert.equal(await stored(), undefined);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'empty-headline');
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'pending-capture' }));
  await page.waitForFunction(async () => !(await chrome.storage.local.get('pendingCapture')).pendingCapture);
  assert.equal(await page.$('[data-view-mode="cleaning"]'), null);
  assert.equal(await stored(), undefined);
  // 抓取已完成，但存储写入本身也延后：仍应被清除时间屏障拦截。
  await worker.evaluate(article => chrome.storage.local.set({ pendingCapture: {
    capturedAt: '2020-01-01T00:00:00.000Z', result: article,
  } }), article);
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'pending-capture' }));
  await page.waitForSelector('[data-testid="margin-clip-note"]');
  assert.equal(await stored(), undefined);
  await page.reload();
  await page.waitForSelector('[data-view-mode="empty"]');
  console.log('✓ 清除失败如实反馈；确认后禁用重复操作，成功才进入空态；待处理文章不会自动提升');

  // 有效 v1 逐字段恢复，无重新抓取、转换或写回。
  await seed(valid);
  assert.deepEqual(await page.evaluate(() => window.__wetrim.loadSession()), valid);
  assert.deepEqual(await stored(), valid);
  assert.equal(await page.$eval('[data-testid="block-item"]', el => el.dataset.blockId), valid.snapshot.blocks[0].id);
  const malformed = [null, false, '', 0, [], { ...valid, schemaVersion: 0 },
    { ...valid, snapshot: { ...valid.snapshot, source: null } },
    { ...valid, snapshot: { ...valid.snapshot, blocks: [valid.snapshot.blocks[0], valid.snapshot.blocks[0]] } },
    { ...valid, snapshot: { ...valid.snapshot, blocks: [{ ...valid.snapshot.blocks[0], editedMarkdown: undefined }] } },
    { ...valid, snapshot: { ...valid.snapshot, captureWarnings: [{ message: 7 }] } }];
  for (const bad of malformed) {
    await seed(bad);
    assert.equal(await page.$('[data-view-mode="cleaning"]'), null);
    assert.deepEqual(await stored(), JSON.parse(JSON.stringify(bad)));
    assert.equal(await page.evaluate(async () => { try { await window.__wetrim.loadSession(); return false; } catch { return true; } }), true);
  }
  console.log('✓ v1 内容、空编辑、取舍与块身份保留；空值、深层损坏、重复块身份与未知版本均不当作空会话');

  await worker.evaluate(valid => chrome.storage.local.set({ currentSession: valid }), valid);
  const patch = await page.evaluateOnNewDocument(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    window.failRead = true;
    chrome.storage.local.get = async keys => {
      if (keys === 'currentSession' && window.failRead) throw new Error('测试：读取暂时失败');
      return get(keys);
    };
  });
  await page.reload();
  await page.waitForSelector('[data-recovery-kind="readError"]');
  assert.equal(await page.$('::-p-text(下载原始备份)'), null);
  assert.equal(await page.$('::-p-text(清除并重新开始)'), null);
  await click('暂不处理');
  assert.match(await page.$eval('.recovery-panel', el => el.textContent), /尚未读到上次进度/);
  await click('继续处理');
  await page.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  assert.deepEqual(await stored(), valid);
  await page.evaluate(() => { window.failRead = false; });
  await click('重试');
  await page.waitForSelector('[data-view-mode="cleaning"]');
  assert.deepEqual(await stored(), valid);
  await page.removeScriptToEvaluateOnNewDocument(patch.identifier);
  console.log('✓ 读取失败仅提供重试与暂不处理；恢复读取后继续原进度');

  // 读取尚未完成时拦截抓取，之后确认恢复旧会话。
  const delayed = await page.evaluateOnNewDocument(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async keys => {
      if (keys === 'currentSession') await new Promise(resolve => { window.finishRead = resolve; });
      return get(keys);
    };
  });
  await page.reload();
  await page.waitForFunction(() => typeof window.finishRead === 'function');
  await page.waitForSelector('[data-recovery-kind="loading"]');
  await page.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  assert.deepEqual(await stored(), valid);
  await page.evaluate(() => window.finishRead());
  await page.waitForSelector('[data-view-mode="cleaning"]');
  assert.deepEqual(await stored(), valid);
  await page.removeScriptToEvaluateOnNewDocument(delayed.identifier);

  await seed(raw);
  const second = await browser.newPage();
  await second.goto(url);
  await second.waitForSelector('[data-testid="read-only-switch-writer"]');
  assert.equal(await second.$('::-p-text(清除并重新开始)'), null);
  assert.equal(await second.$('.recovery-panel'), null);
  await second.evaluate(article => window.__wetrim.processCaptureResult(article), article);
  assert.deepEqual(await stored(), raw);
  // #36：只读页不读取或展示会话，只有接管后才进入恢复流程。
  await page.close();
  await second.waitForSelector('[data-recovery-kind="unrecognized"]');
  assert.deepEqual(await stored(), raw);
  await second.close();
  assert.deepEqual(errors, []);
  console.log('✓ 恢复未确定期间拦截新文章；只读副本不能清除或写入');
  console.log(`截图及真实下载备份：${artifacts}`);
} finally {
  await browser.close();
}
