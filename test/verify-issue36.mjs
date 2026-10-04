import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker')).worker();
  const url = `chrome-extension://${await worker.evaluate(() => chrome.runtime.id)}/app.html`;
  const open = async () => { const p = await browser.newPage(); p.setDefaultTimeout(8000); await p.goto(url); return p; };
  let first = await open();
  await first.waitForSelector('[data-view-mode="empty"]');
  await first.evaluate(() => window.__wetrim.processCaptureResult({ kind: 'article',
    source: { title: '仲裁测试', account: null, publishedAt: null, url: 'https://mp.weixin.qq.com/s/test' },
    contentHtml: '<p>最后成功保存的内容</p>', unstable: false }));
  await first.waitForSelector('[data-save-status="saved"]');
  const second = await open();
  const third = await open();
  await second.bringToFront();
  await second.waitForSelector('[data-testid="read-only-switch-writer"]');
  assert.equal(await second.$('[data-testid="manuscript-slip"]'), null, '只读页不展示文章');
  assert.equal(await second.$('[data-testid="save-status"]'), null);
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'wetrim-issue36-'));
  await second.setViewport({ width: 1200, height: 900 });
  await second.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  await second.setViewport({ width: 360, height: 800 });
  assert(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await second.screenshot({ path: path.join(artifacts, 'narrow.png'), fullPage: true });
  console.log(`截图：${artifacts}`);
  await second.bringToFront();
  // 切换失败必须就地可重试。
  await second.evaluate(() => {
    window.originalUpdate = chrome.tabs.update;
    chrome.tabs.update = async () => { throw new Error('模拟切换失败'); };
  });
  await second.click('[data-testid="read-only-switch-writer"]');
  await second.waitForFunction(() => document.body.textContent.includes('切换未完成'));
  await second.evaluate(() => { chrome.tabs.update = window.originalUpdate; });
  await second.click('[data-testid="read-only-switch-writer"]');
  await first.waitForFunction(() => document.visibilityState === 'visible', { polling: 100 });
  // 连续图标调用应复用写入页；worker 停止后重启，仍按实时 tabId 查找。
  await worker.evaluate(async () => {
    await Promise.all(Array.from({ length: 5 }, () => self.__wetrimBackground.handleActionClick({ id: 999999 })));
  });
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')] }))).length, 3);
  const browserCdp = await first.createCDPSession();
  await browserCdp.send('ServiceWorker.enable');
  await browserCdp.send('ServiceWorker.stopAllWorkers');
  await third.evaluate(() => { void chrome.runtime.sendMessage({ type: 'wake-worker-test' }).catch(() => {}); });
  await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 8000 });
  await third.bringToFront();
  await first.close();
  await second.waitForFunction(() => document.querySelector('[data-view-mode="cleaning"]'), { polling: 100 });
  assert.match(await second.$eval('[data-testid="manuscript-slip"]', el => el.textContent), /最后成功保存的内容/);
  assert.equal(await third.evaluate(() => document.visibilityState), 'visible', '接管不得抢前台');
  await third.waitForSelector('[data-testid="read-only-switch-writer"]');
  await second.waitForFunction(() => document.activeElement?.tagName === 'H1', { polling: 100 });
  await second.close();
  await third.waitForSelector('[data-view-mode="cleaning"]');
  assert.match(await third.$eval('body', el => el.textContent), /已在此页面继续编辑/);
  console.log('✓ 三页最小 tabId 仲裁、逐次接管、焦点与播报、不抢前台、连续点击及 worker 重启');

  first = third;
  const stored = () => first.evaluate(async () => (await chrome.storage.local.get('currentSession')).currentSession);
  const saved = await stored();
  // 处理 A 的候选写入期间收到 B 的通知，串行处理完成后必须补查。
  const sender = await open();
  await sender.waitForSelector('[data-testid="read-only-switch-writer"]');
  await first.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    let pause = true;
    chrome.storage.local.set = async items => {
      if (items.candidateSnapshot && pause) {
        pause = false;
        await new Promise(resolve => { window.finishCandidate = resolve; });
      }
      return set(items);
    };
  });
  const sendCapture = title => sender.evaluate(async title => {
    await chrome.storage.local.set({ pendingCapture: { capturedAt: new Date().toISOString(), result: {
      kind: 'article', source: { title, account: null, publishedAt: null, url: 'https://mp.weixin.qq.com/s/' + title },
      contentHtml: '<p>后到的候选</p>', unstable: false,
    } } });
    void chrome.runtime.sendMessage({ type: 'pending-capture' }).catch(() => {});
  }, title);
  await sendCapture('候选 A');
  await first.waitForFunction(() => typeof window.finishCandidate === 'function', { polling: 100 });
  await sendCapture('候选 B');
  await first.evaluate(() => window.finishCandidate());
  await first.waitForFunction(() => document.body.textContent.includes('候选 B'), { polling: 100 });
  assert.equal(await sender.evaluate(async () => (await chrome.storage.local.get('pendingCapture')).pendingCapture), undefined);
  await sender.close();
  await first.bringToFront();
  await first.click('[data-testid="candidate-btn-continue"]');
  console.log('✓ 在途候选处理期间的新通知会补查，不丢失后到抓取');

  // 启动查询失败与恢复：失败期间不能展示编辑器，也不能走直接写入路径。
  const patch = await first.evaluateOnNewDocument(() => {
    const query = chrome.runtime.getContexts.bind(chrome.runtime);
    window.failQuery = true;
    chrome.runtime.getContexts = (...args) => window.failQuery ? Promise.reject(new Error('查询失败')) : query(...args);
  });
  await first.reload();
  await first.waitForSelector('[data-instance-mode="error"]');
  assert.equal(await first.$('[data-testid="manuscript-slip"]'), null);
  const denied = await first.evaluate(async saved => {
    try { await window.__wetrim.saveSessionDirect({ ...saved, revision: 999 }); return false; } catch { return true; }
  }, saved);
  assert(denied);
  assert.deepEqual(await stored(), saved);
  await first.evaluate(() => { window.failQuery = false; });
  await (await first.waitForSelector('::-p-aria([name="重试"][role="button"])')).click();
  await first.waitForSelector('[data-view-mode="cleaning"]');
  await first.removeScriptToEvaluateOnNewDocument(patch.identifier);
  console.log('✓ 启动检查失败保护与重试，所有直接写入也受资格约束');

  // 资格查询失败遇到未保存修改：保留副本，显式放弃后重新读取存档。
  await first.evaluate(() => {
    window.originalSet = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('磁盘失败'); };
  });
  await first.click('[data-testid="block-action-exclude"]');
  await first.waitForSelector('[data-save-status="error"]');
  await first.evaluate(() => {
    window.originalQuery = chrome.runtime.getContexts;
    chrome.runtime.getContexts = async () => { throw new Error('查询失败'); };
  });
  await first.waitForSelector('.instance-draft');
  assert.deepEqual(await stored(), saved);
  const downloadCdp = await browser.target().createCDPSession();
  await downloadCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts });
  await (await first.waitForSelector('::-p-aria([name="下载未保存副本"][role="button"])')).click();
  let draft;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { draft = JSON.parse(await fs.readFile(path.join(artifacts, 'WeTrim-未保存修改.json'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(draft.snapshot.blocks[0].included, false, '真实下载保留未保存的取舍');
  await first.evaluate(() => {
    chrome.runtime.getContexts = window.originalQuery;
    chrome.storage.local.set = window.originalSet;
  });
  await (await first.waitForSelector('::-p-aria([name="放弃此页未保存修改并继续"][role="button"])')).click();
  await first.waitForSelector('[data-view-mode="cleaning"]');
  assert.deepEqual(await stored(), saved);
  await first.waitForSelector('[data-testid="block-action-exclude"]');
  console.log('✓ 未保存副本保留，显式放弃后恢复存档且不回写旧副本');

  // 接管时才读取：无记录、损坏记录和读取失败进入对应现有流程。
  for (const kind of ['empty', 'unrecognized', 'readError']) {
    const successor = await open();
    await successor.waitForSelector('[data-testid="read-only-switch-writer"]');
    if (kind === 'empty') await first.evaluate(() => chrome.storage.local.remove('currentSession'));
    else if (kind === 'unrecognized') await first.evaluate(() => chrome.storage.local.set({ currentSession: { schemaVersion: 99 } }));
    else await successor.evaluate(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = keys => keys === 'currentSession' ? Promise.reject(new Error('读取失败')) : get(keys);
    });
    if (kind === 'empty') {
      const oldId = await first.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      await successor.evaluate(oldId => {
        const update = chrome.tabs.update.bind(chrome.tabs);
        chrome.tabs.update = async (id, properties) => {
          if (id === oldId) { await chrome.tabs.remove(oldId); throw new Error('切回目标刚关闭'); }
          return update(id, properties);
        };
      }, oldId);
      await successor.click('[data-testid="read-only-switch-writer"]');
    } else await first.close();
    await successor.waitForSelector(kind === 'empty' ? '[data-view-mode="empty"]' : `[data-recovery-kind="${kind}"]`);
    first = successor;
  }
  console.log('✓ 接管重新读盘，空记录、损坏记录、读取失败均进入正确流程');
  await first.bringToFront();
  await first.evaluate(() => {
    const query = chrome.runtime.getContexts.bind(chrome.runtime);
    let failOnce = true;
    chrome.runtime.getContexts = (...args) => {
      if (failOnce) { failOnce = false; return Promise.reject(new Error('恢复重试仲裁失败')); }
      return query(...args);
    };
    // 直接点击，保证单次失败命中恢复重试而非定时检查。
    [...document.querySelectorAll('button')].find(b => b.textContent === '重试').click();
  });
  await first.waitForSelector('[data-instance-mode="error"]');
  await (await first.waitForSelector('::-p-aria([name="重试"][role="button"])')).click();
  await first.waitForSelector('[data-recovery-kind="readError"]');
  console.log('✓ 恢复重试遇单次仲裁失败仍可再次重试');
} finally { await browser.close(); }

// 使用真实用户配置关闭并重启浏览器，验证会话恢复产生的并存页面。
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wetrim-restore36-'));
const launchRestored = () => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  userDataDir: profile, enableExtensions: [path.resolve('dist')],
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--restore-last-session'] });
let restored = await launchRestored();
try {
  const worker = await (await restored.waitForTarget(t => t.type() === 'service_worker')).worker();
  const url = `chrome-extension://${await worker.evaluate(() => chrome.runtime.id)}/app.html`;
  const page = await restored.newPage();
  await page.goto(url);
  await page.waitForSelector('[data-view-mode="empty"]');
  await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.duplicate(tab.id);
    await chrome.tabs.duplicate(tab.id);
  });
  await page.waitForFunction(async () => (await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')] })).length === 3, { polling: 100 });
  await restored.close();
  restored = await launchRestored();
  await restored.waitForTarget(t => t.url() === url);
  await new Promise(resolve => setTimeout(resolve, 1500));
  // Puppeteer 在 Chrome 启动后通过 CDP 加载未打包扩展；浏览器先恢复的标签因此暂为错误页。
  // 验证历史中确实是恢复的 app.html，并在扩展加载完成后重载这些原标签，保留浏览器分配的 tabId。
  const pages = [];
  for (const page of await restored.pages()) {
    const cdp = await page.createCDPSession();
    const history = await cdp.send('Page.getNavigationHistory');
    if (history.entries[history.currentIndex]?.url === url) pages.push(page);
    await cdp.detach();
  }
  await Promise.all(pages.map(page => page.reload()));
  assert.equal(pages.length, 3, '真实会话恢复保留三个扩展页');
  const states = [];
  for (const page of pages) {
    await page.bringToFront();
    await page.waitForSelector('[data-view-mode="empty"], [data-instance-mode="readonly"]');
    states.push(await page.evaluate(async () => ({ id: (await chrome.tabs.getCurrent()).id,
      readonly: Boolean(document.querySelector('[data-instance-mode="readonly"]')) })));
  }
  assert.equal(states.filter(s => !s.readonly).length, 1);
  assert.equal(states.find(s => !s.readonly).id, Math.min(...states.map(s => s.id)));
  console.log('✓ Chrome 原生复制标签及关闭重启后的真实会话恢复：最小 tabId 唯一编辑页');
} finally {
  await restored.close();
  await fs.rm(profile, { recursive: true, force: true });
}
