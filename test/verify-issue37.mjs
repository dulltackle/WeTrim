import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const behaviorOnly = process.argv.includes('--behavior-only');
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox'],
});
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const worker = await target.worker();
  const id = await worker.evaluate(() => chrome.runtime.id);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForFunction(() => window.__wetrim && !window.__wetrim.getState().isLoading);
  const boundaries = await page.evaluate(() => {
    return [999, 1000, 1200].map(count => {
      const snapshot = window.__wetrim.buildArticleSnapshot({
        kind: 'article', source: { title: '长文边界', url: 'https://mp.weixin.qq.com/s/test', account: null, publishedAt: null },
        contentHtml: '<p>保留全文</p>'.repeat(count), unstable: false,
      });
      return { count: snapshot.blocks.length, warning: snapshot.captureWarnings.some(w => w.code === 'long-article') };
    });
  });
  assert.deepEqual(boundaries, [{ count: 999, warning: false }, { count: 1000, warning: true }, { count: 1200, warning: true }]);
  console.log('✓ 解析完成即判定 999 / 1000 / 1200 块，全文保留');
  const fixture = JSON.parse(fs.readFileSync('test/fixtures/wetrim-sample-deep-longform.json', 'utf8'));
  const captures = [
    { name: '真实347', kind: 'article', source: { title: fixture.title, url: fixture.sourceUrl, account: null, publishedAt: null }, contentHtml: fixture.RESULTS.content.after.html, unstable: false },
    { name: '构造600', kind: 'article', source: { title: '构造600块', url: 'https://mp.weixin.qq.com/s/test', account: null, publishedAt: null }, contentHtml: Array.from({length: 600}, (_, i) => i % 10 === 0 ? `<p><img src="https://mmbiz.qpic.cn/perf-${i}.png" /></p>` : `<p>第${i}段${i % 5 === 0 ? '骨骼研究' : '长文研究'}：${'这是供长文清洗性能验收使用的正文，包含足够的文字和标点。'.repeat(2)}</p>`).join(''), unstable: false },
  ];
  // 图片网络不纳入文字交互预算；另行验证挂起、失败和重试。
  await page.setRequestInterception(true);
  let imageMode = 'pending';
  const pendingImages = [];
  page.on('request', req => {
    if (req.resourceType() !== 'image' || imageMode === 'live') return void req.continue();
    if (imageMode === 'pending') pendingImages.push(req);
    else if (imageMode === 'fail') void req.abort();
    else void req.respond({ status: 200, contentType: 'image/png', body: fs.readFileSync('public/icons/icon-48.png') });
  });
  const report = { chrome: await browser.version(), cpuRate: 4, viewport: '1280×900', rounds: [] };
  for (const capture of behaviorOnly ? [] : captures) {
    for (let round = 0; round < 3; round++) {
      await worker.evaluate(() => chrome.storage.local.clear());
      await page.reload();
      await page.waitForFunction(() => window.__wetrim && window.__wetrim.getState().viewMode === 'empty');
      const result = await page.evaluate(async capture => {
        const api = window.__wetrim;
        const sourceDoc = new DOMParser().parseFromString(capture.contentHtml, 'text/html');
        const sourceElements = (sourceDoc.getElementById('js_content') ?? sourceDoc.body).querySelectorAll('*').length;
        const sourceSpans = sourceDoc.body.querySelectorAll('span').length;
        const q = testid => document.querySelector(`[data-testid="${testid}"]`);
        // 观察真实 DOM 状态，再跨过一帧的绘制机会；不以 rAF 开始当作渲染结束。
        const settle = async predicate => {
          const deadline = performance.now() + 10000;
          while (!predicate()) {
            if (performance.now() > deadline) throw new Error('界面结果超时');
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          document.body.getBoundingClientRect();
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        };
        const measure = async (action, predicate) => {
          await new Promise(resolve => setTimeout(resolve, 250));
          const t = performance.now();
          action();
          await settle(predicate);
          return performance.now() - t;
        };
        const input = (el, value) => {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const start = performance.now();
        await api.processCaptureResult(capture);
        await settle(() => q('block-action-edit'));
        const load = performance.now() - start;
        const count = [...document.querySelectorAll('[data-testid="block-item"]')].filter(el=>!el.closest('[hidden]')).length;
        const warning = !!q('long-article-note');
        await api.sessionSaveQueue.flush();
        const toggle = await measure(() => q('block-action-exclude').click(), () => q('block-item').dataset.blockIncluded === 'false');
        await measure(() => q('block-action-restore').click(), () => q('block-item').dataset.blockIncluded === 'true');
        const open = await measure(() => q('block-action-edit').click(), () => q('block-editor-textarea'));
        const before = q('block-editor-textarea').value;
        const edit = await measure(() => input(q('block-editor-textarea'), before + '字'), () => q('block-item').dataset.blockEdited === 'true');
        const close = await measure(() => q('block-action-finish-edit').click(), () => !q('block-editor-textarea'));
        await api.sessionSaveQueue.flush();
        const preview = await measure(() => q('action-preview').click(), () => q('preview-dialog')?.open && q('preview-panel-reading')?.textContent.includes('字'));
        q('preview-btn-return').click();
        await settle(() => !q('preview-dialog')?.open);
        const search = await measure(() => input(q('search-input'), '骨骼'), () => q('search-counter'));
        q('search-clear-btn').click();
        await settle(() => !q('search-counter'));
        // 保留与剔除均有实际内容，覆盖重新挂载整篇的回程。
        q('block-action-exclude').click();
        await settle(() => q('block-item').dataset.blockIncluded === 'false');
        const filterOut = await measure(() => q('filter-tab-excluded').click(), () => [...document.querySelectorAll('[data-testid="block-item"]')].filter(el=>!el.closest('[hidden]')).length === 1);
        const filterAll = await measure(() => q('filter-tab-all').click(), () => [...document.querySelectorAll('[data-testid="block-item"]')].filter(el=>!el.closest('[hidden]')).length === count);
        // 另测分散剔除，避免只覆盖能整组隐藏的单个剔除块场景。
        const current = api.getState().session;
        const mixed = { ...current, revision: current.revision + 1, snapshot: { ...current.snapshot,
          blocks: current.snapshot.blocks.map((block, i) => ({ ...block, included: i % 7 !== 0 })) } };
        api.dispatch({type:'SET_NEW_SESSION',payload:mixed});
        await settle(() => api.getState().session.revision === mixed.revision);
        const filterMixedOut = await measure(() => q('filter-tab-excluded').click(), () => [...document.querySelectorAll('[data-testid="block-item"]')].filter(el=>!el.closest('[hidden]')).length === Math.ceil(count/7));
        const filterMixedAll = await measure(() => q('filter-tab-all').click(), () => [...document.querySelectorAll('[data-testid="block-item"]')].filter(el=>!el.closest('[hidden]')).length === count);
        await api.sessionSaveQueue.flush();
        const session = { ...api.getState().session, revision: api.getState().session.revision + 1,
          savedAt: new Date().toISOString() };
        const serialStart = performance.now();
        const serialized = JSON.stringify(session);
        const serialize = performance.now() - serialStart;
        const writeStart = performance.now();
        await chrome.storage.local.set({ currentSession: session });
        const storage = performance.now() - writeStart;
        if ((await chrome.storage.local.get('currentSession')).currentSession.revision !== session.revision) throw new Error('真实写入读回不一致');
        const nextSession = { ...session, revision: session.revision + 1 };
        const saveStart = performance.now();
        await api.saveSessionDirect(nextSession);
        const save = performance.now() - saveStart;
        if ((await chrome.storage.local.get('currentSession')).currentSession.revision !== nextSession.revision) throw new Error('生产保存读回不一致');
        // 单独测转换，不包含切块；使用同一真实快照的原始 HTML。
        const rawBlocks = api.splitBlocks(capture.contentHtml);
        const convertStart = performance.now();
        const converted = api.convertBlocks(rawBlocks, { baseUrl: capture.source.url });
        const convert = performance.now() - convertStart;
        return { name: capture.name, sourceElements, sourceSpans, count, warning, load, toggle, open, edit, close, preview, search, filterOut, filterAll, filterMixedOut, filterMixedAll, serialize, storage, save, convert, convertedCount: converted.length, bytes: new TextEncoder().encode(serialized).length };
      }, capture);
      report.rounds.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const imageCountBoundary = await page.evaluate(() => {
    const snapshot = window.__wetrim.buildArticleSnapshot({kind: 'article', source: {title:'多图引用',url:'https://mp.weixin.qq.com/s/images',account:null,publishedAt:null}, unstable:false,
      contentHtml: '<blockquote>' + Array.from({length:1001}, (_,i) => `<img src="https://mmbiz.qpic.cn/${i}.png">`).join('') + '</blockquote>'});
    return {blocks:snapshot.blocks.length,images:snapshot.images.length,warning:snapshot.captureWarnings.some(w=>w.code==='long-article')};
  });
  assert.deepEqual(imageCountBoundary,{blocks:1,images:1001,warning:false});
  await worker.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await page.waitForFunction(() => window.__wetrim?.getState().viewMode === 'empty');
  await page.evaluate(async () => {
    await window.__wetrim.processCaptureResult({kind:'article',source:{title:'长文提示验收',url:'https://mp.weixin.qq.com/s/large',account:null,publishedAt:null},unstable:false,contentHtml:'<p>可以继续清洗的正文。</p>'.repeat(1000)});
  });
  await page.waitForSelector('[data-testid="long-article-note"]');
  assert.equal(await page.$$eval('[data-testid="block-item"]', items=>items.length),1000);
  await page.click('[data-testid="block-action-exclude"]');
  await page.waitForSelector('[data-testid="block-item"][data-block-included="false"]');
  await page.screenshot({path:'/tmp/wetrim-issue37-desktop.png'});
  await page.setViewport({width:480,height:900});
  await page.screenshot({path:'/tmp/wetrim-issue37-narrow.png'});
  await page.setViewport({width:1280,height:900});
  await page.reload();
  await page.waitForSelector('[data-testid="long-article-note"]');
  await page.click('[data-block-order="40"] [data-testid="block-action-edit"]');
  await page.type('[data-testid="block-editor-textarea"]','隐藏前的编辑');
  await page.click('[data-testid="filter-tab-excluded"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="block-editor-textarea"]'));
  const hiddenState = await page.evaluate(() => {
    const targets = [40,2].flatMap(order => {
      const block = document.querySelector(`[data-block-order="${order}"]`);
      return [block,block.querySelector('button')];
    });
    const focused = targets.some(target => { target.focus(); return document.activeElement===target; });
    return {focused,height:document.body.scrollHeight,
      text:window.__wetrim.getState().session.snapshot.blocks[39].editedMarkdown};
  });
  assert.equal(hiddenState.focused,false,'整组及混合组隐藏的块与控件不能获得焦点');
  assert(hiddenState.height<2000,'筛选掉的组不留下正文高度');
  assert(hiddenState.text.includes('隐藏前的编辑'),'隐藏整组前保存编辑');
  await page.click('[data-testid="filter-tab-all"]');
  await page.waitForFunction(() => document.querySelector('[data-block-order="40"]').textContent.includes('隐藏前的编辑'));
  console.log('✓ 1000 块可继续取舍并恢复提示；1 块含 1001 个图片资源不触发提示');

  // 图片一直挂起时能编辑；随后失败给出占位与重试，重试真正发起请求并恢复图片。
  await worker.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await page.waitForFunction(() => window.__wetrim?.getState().viewMode === 'empty');
  const requestStart = pendingImages.length;
  await page.evaluate(async () => window.__wetrim.processCaptureResult({kind:'article',source:{title:'图片与输入',url:'https://mp.weixin.qq.com/s/images',account:null,publishedAt:null},unstable:false,
    contentHtml:'<p>图片挂起时也能编辑</p><img src="https://mmbiz.qpic.cn/pending.png"><p>后续文字</p>'}));
  await page.waitForSelector('[data-testid="image-loading-placeholder"]');
  await page.click('[data-testid="block-action-edit"]');
  await page.type('[data-testid="block-editor-textarea"]','未被阻塞');
  assert((await page.$eval('[data-testid="block-editor-textarea"]',el=>el.value)).includes('未被阻塞'));
  imageMode = 'fail';
  for (const request of pendingImages.slice(requestStart)) {
    if (!request.isInterceptResolutionHandled()) await request.abort();
  }
  await page.waitForSelector('[data-testid="image-error-card"]');
  imageMode = 'success';
  await page.click('[data-testid="image-retry-btn"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="image-thumbnail-img"]')?.naturalWidth > 0);
  console.log('✓ 图片挂起不阻断文字编辑，失败占位及真实请求重试通过');

  await worker.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await page.waitForFunction(() => window.__wetrim?.getState().viewMode === 'empty');
  await page.evaluate(capture => window.__wetrim.processCaptureResult(capture), captures[0]);
  await page.waitForSelector('[data-testid="block-action-edit"]');
  await page.click('[data-testid="block-action-edit"]');

  // 保存进行期间仍可输入：统计真实 API 调用及同步阶段，存储读回校验最新文字。
  const inputDuringSave = await page.evaluate(async () => {
    const api = window.__wetrim;
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    const writes = [];
    chrome.storage.local.set = (...args) => {
      const start = performance.now();
      const promise = original(...args);
      const synchronous = performance.now() - start;
      return promise.then(result => { writes.push({synchronous,total:performance.now()-start}); return result; });
    };
    try {
      const editor = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      for (let i=0;i<30;i++) {
        setter.call(editor,editor.value+'续');
        editor.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      api.blockListRef.current.flushPendingEdits();
      await new Promise(resolve=>setTimeout(resolve,0));
      await api.sessionSaveQueue.flush();
      const saved = (await chrome.storage.local.get('currentSession')).currentSession;
      return {writes, text:saved.snapshot.blocks[0].editedMarkdown, value:editor.value};
    } finally { chrome.storage.local.set = original; }
  });
  assert(inputDuringSave.writes.length>=2,'持续输入期间 2 秒保存上限生效');
  assert.equal(inputDuringSave.text,inputDuringSave.value);
  assert(inputDuringSave.writes.every(w=>w.synchronous<50 && w.total<200));
  report.inputDuringSave = inputDuringSave.writes;
  if (!behaviorOnly) fs.writeFileSync('/tmp/wetrim-issue37-results.json', JSON.stringify(report, null, 2));
  for (const r of report.rounds) {
    assert.equal(r.count, r.name === '真实347' ? 347 : 600);
    assert.equal(r.warning, false);
    if (r.name === '真实347') {
      assert.equal(r.sourceSpans,4234);
      assert.equal(r.sourceElements,5569);
    }
    for (const [metric, limit] of Object.entries({load:1500,toggle:100,open:100,edit:50,close:100,preview:300,search:100,filterOut:100,filterAll:100,filterMixedOut:100,filterMixedAll:100,save:200})) {
      assert(r[metric] <= limit, `${r.name} ${metric}: ${r[metric].toFixed(1)} ms 超出 ${limit} ms`);
    }
  }
} finally {
  await browser.close();
}
