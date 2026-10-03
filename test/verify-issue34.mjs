import puppeteer from 'puppeteer';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  enableExtensions: [path.resolve('dist')], args: ['--no-sandbox'],
});
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const worker = await target.worker();
  const id = await worker.evaluate(() => chrome.runtime.id);
  await worker.evaluate(() => chrome.storage.local.clear());
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith('http') ? req.abort() : req.continue());
  page.on('pageerror', error => console.error(error));
  page.setDefaultTimeout(5000);
  await page.goto(`chrome-extension://${id}/app.html`, {waitUntil:'networkidle0'});
  await page.waitForFunction(() => window.__wetrim?.writeArticleDirectory);
  await page.evaluate(() => {
    window.permissionRequests = 0;
    chrome.permissions.request = async () => { window.permissionRequests++; return false; };
    window.makeSnapshot = (contents) => ({
      snapshotId: 'issue34', capturedAt: new Date().toISOString(),
      source: {title: '图片导出测试', account:null, publishedAt:null, url: 'https://mp.weixin.qq.com/s/test'}, images: [],
      blocks: contents.map((initialMarkdown, i) => ({
        id: `b${i}`, order: i + 1, type: 'paragraph', included: true,
        initialMarkdown, editedMarkdown: null, originalHtml: '', notes: [],
      })),
    });
    window.makeDirectory = () => {
      const writes = [];
      const entries = new Map();
      const directory = (prefix) => ({
        async getDirectoryHandle(name, {create} = {}) {
          const key = `${prefix}${name}/`;
          if (!entries.has(key)) {
            if (!create) throw new DOMException('', 'NotFoundError');
            writes.push(key); entries.set(key, directory(key));
          }
          return entries.get(key);
        },
        async getFileHandle(name, {create} = {}) {
          if (!create) throw new DOMException('', 'NotFoundError');
          return {async createWritable() {return {
            async write(data) {writes.push({name: `${prefix}${name}`, data});},
            async close() {}, async abort() {},
          };}};
        },
        async *keys() {},
      });
      return {root: directory(''), writes};
    };
    window.pngFetch = async () => new Response(new Uint8Array([137,80,78,71,13,10,26,10]), {status:200});
  });
  const paused = await page.evaluate(async () => {
    const fs = makeDirectory();
    let fetched = 0;
    const result = await __wetrim.writeArticleDirectory(fs.root,
      makeSnapshot(['正文 ![外站](https://example.com/a.png)']), {
        fetchFn: async () => {fetched++; return pngFetch();},
      });
    return {ok: result.ok, writes: fs.writes.length, fetched};
  });
  assert.deepEqual(paused, {ok:false, writes:0, fetched:0}, '外站图片默认暂停，零下载、零写入');
  console.log('✓ 外站图片默认暂停，确认前零写入');
  const relative = await page.evaluate(async () => {
    const fs = makeDirectory();
    await __wetrim.writeArticleDirectory(fs.root, makeSnapshot(['![图](/image.png) ![图](//example.com/image.png)']), {onUnlocalized:async ()=>'continue'});
    return fs.writes.find(w => w.name?.endsWith('.md')).data;
  });
  assert.match(relative, /!\[图\]\(https:\/\/mp.weixin.qq.com\/image.png\)/);
  assert.match(relative, /!\[图\]\(https:\/\/example.com\/image.png\)/);
  const multiline = await page.evaluate(async () => {
    const fs = makeDirectory();
    const result = await __wetrim.writeArticleDirectory(fs.root, makeSnapshot(['![a](https://mmbiz.qpic.cn/img)', '![a\nb][ref]', '[ref]: https://mmbiz.qpic.cn/img', '[普通链接][ref]']), {fetchFn:pngFetch});
    return {ok:result.ok, external:result.failedImagesCount, text:fs.writes.find(w=>w.name?.endsWith('.md'))?.data};
  });
  assert.equal(multiline.ok, true);
  assert.equal(multiline.external, 0);
  assert.match(multiline.text, /!\[a\nb\]\(images\/image-001.png\)/);
  assert.match(multiline.text, /\[ref\]: https:\/\/mmbiz.qpic.cn\/img/);
  console.log('✓ 相对地址保留完整网络链接、共享定义的多行图片全部本地化');

  const invalid = await page.evaluate(async () => {
    const fs = makeDirectory();
    let problems;
    const result = await __wetrim.writeArticleDirectory(fs.root,
      makeSnapshot(['正文 ![坏图]()', '![引用][地址]', '[地址]: javascript:bad']), {
        fetchFn: pngFetch,
        onUnlocalized: async images => { problems = images; return 'continue'; },
      });
    return {ok:result.ok, writes:fs.writes.length, problems:problems?.map(p => ({
      canKeepExternal:p.canKeepExternal, locations:p.locations.map(l => l.blockId),
      definition:p.locations[0]?.definition?.blockId,
    }))};
  });
  assert.equal(invalid.ok, false, '无效地址不能通过继续决定绕过');
  assert.equal(invalid.writes, 0);
  assert.deepEqual(invalid.problems, [
    {canKeepExternal:false, locations:['b0']},
    {canKeepExternal:false, locations:['b1'], definition:'b2'},
  ]);
  console.log('✓ 无效地址阻断与跨块定义位置');
  const retry = await page.evaluate(async () => {
    const fs = makeDirectory();
    const requests = []; let rounds = 0; let permission = false;
    const snapshot = makeSnapshot(['![成功](https://mmbiz.qpic.cn/ok)', '![重试](https://mmbiz.qpic.cn/retry)', '![缺权限](https://mmbiz.qlogo.cn/permission)', '![外站](https://example.com/out)']);
    snapshot.blocks[0].initialMarkdown = '旧内容';
    snapshot.blocks[0].editedMarkdown = '![新增](https://mmbiz.qpic.cn/ok)';
    const seen = [];
    const result = await __wetrim.writeArticleDirectory(fs.root, snapshot, {
      hasPermission: async url => !url.includes('qlogo') || permission,
      fetchFn: async url => {
        requests.push(url);
        if (url.endsWith('/retry') && rounds === 0) return new Response('', {status:403});
        return pngFetch();
      },
      onUnlocalized: async images => {
        if (fs.writes.length) throw Error('确认前写入');
        seen.push(images.map(i => i.reason));
        rounds++; permission = true;
        return rounds === 1 ? 'retry' : 'continue';
      },
    });
    return {result: {ok:result.ok, local:result.localizedImagesCount, external:result.failedImagesCount},
      requests, seen, text:fs.writes.find(w => w.name?.endsWith('.md'))?.data};
  });
  assert.deepEqual(retry.result, {ok:true, local:3, external:1});
  assert.deepEqual(retry.requests, ['https://mmbiz.qpic.cn/ok','https://mmbiz.qpic.cn/retry','https://mmbiz.qpic.cn/retry','https://mmbiz.qlogo.cn/permission']);
  assert.match(retry.seen[0][0], /403/);
  assert.match(retry.seen[0][1], /权限/);
  assert.match(retry.seen[0][2], /自动下载范围/);
  assert.equal(retry.seen[1].length, 1);
  assert.match(retry.text, /images\/image-001.png/);
  assert.match(retry.text, /https:\/\/example.com\/out/);
  console.log('✓ 编辑后新增图片、权限缺失、403、重试复用及明确保留外链');

  const errors = await page.evaluate(async () => {
    const fs = makeDirectory(); let reasons;
    const result = await __wetrim.writeArticleDirectory(fs.root,
      makeSnapshot(['![网络](https://mmbiz.qpic.cn/network)', '![非图片](https://mmbiz.qpic.cn/html)']), {
        fetchFn: async url => {
          if (url.endsWith('network')) throw new TypeError('Failed to fetch');
          return new Response('<html>错误页</html>', {headers:{'content-type':'text/html'}});
        },
        onUnlocalized: async images => {reasons = images.map(i => i.reason); return 'cancel';},
      });
    return {ok:result.ok, writes:fs.writes.length, reasons};
  });
  assert.equal(errors.writes, 0);
  assert.match(errors.reasons[0], /网络连接失败/);
  assert.match(errors.reasons[1], /不是可识别的图片/);
  console.log('✓ 实际扩展授权下的网络错误及非图片响应');

  await page.evaluate(() => {
    const snapshot = makeSnapshot(['第一处 ![图][共享]', '第二处 ![图](https://example.com/image.png)', '[共享]: https://example.com/image.png']);
    snapshot.captureWarnings = [];
    __wetrim.dispatch({type:'INIT_STORAGE_STATE',payload:{
      session:{schemaVersion:1,sessionId:'issue34',revision:1,savedAt:new Date().toISOString(),snapshot},
      candidateSnapshot:null,corrupted:false,isReadOnly:false,
    }});
    window.testFs = makeDirectory();
    window.showDirectoryPicker = async () => testFs.root;
  });
  await page.waitForSelector('[data-testid="action-export"]');
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]', {timeout:2000});
  assert.equal(await page.evaluate(() => testFs.writes.length), 0);
  assert.equal(await page.$$eval('[data-testid="unlocalized-item"]', els => els.length), 1);
  assert.equal(await page.$$eval('[data-testid="image-locate"]', els => els.length), 2);
  assert.equal(await page.$eval('[data-testid="image-continue"]', el => el === document.activeElement), false);
  await page.click('[data-testid="image-definition"]');
  await page.waitForSelector('[data-block-id="b2"] textarea');
  assert.equal(await page.$eval('[data-block-id="b2"] textarea', el => el.value.slice(el.selectionStart,el.selectionEnd)), '[共享]: https://example.com/image.png');
  assert.equal(await page.evaluate(() => testFs.writes.length), 0);
  console.log('✓ 暂停对话框合并地址、列出全部引用、定位定义并取消写入');
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlocalized-dialog"]'));
  assert.equal(await page.$eval('[data-testid="action-export"]', el => el === document.activeElement), true);
  await page.click('[data-testid="action-preview"]');
  await page.click('[data-testid="preview-btn-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlocalized-dialog"]'));
  assert.equal(await page.$eval('[data-testid="preview-btn-export"]', el => el === document.activeElement), true);
  await page.click('[data-testid="preview-btn-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.click('[data-testid="image-locate"]');
  await page.waitForSelector('[data-block-id="b0"] textarea');
  assert.equal(await page.$eval('[data-block-id="b0"] textarea', el => el.value.slice(el.selectionStart, el.selectionEnd)), '![图][共享]');
  assert.equal(await page.$('[data-testid="preview-dialog"][open]'), null);
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.click('[data-testid="image-continue"]');
  await page.waitForSelector('[data-testid="export-dialog"][open]');
  assert.match(await page.$eval('[data-testid="export-dialog-title"]', el => el.textContent), /含 1 张外链图片/);
  assert.match(await page.$eval('[data-testid="export-dialog-desc"]', el => el.textContent), /导出产物.*不保证离线完整/);
  assert.equal(await page.evaluate(() => testFs.writes.length), 2);
  console.log('✓ 预览定位、Esc 焦点返回、用户确认和含外链结果反馈');
  await page.click('[data-testid="export-dialog-btn-close"]');
  await page.evaluate(() => {
    const snapshot = makeSnapshot(Array.from({length:16}, (_, i) => `第 ${i+1} 处图片 ![图](https://example.com/${'very-long-address-'.repeat(8)}${i}.png)`));
    snapshot.blocks.push({...snapshot.blocks[0], id:'invalid', order:17, initialMarkdown:'![地址待修正]()'});
    snapshot.captureWarnings = [];
    __wetrim.dispatch({type:'INIT_STORAGE_STATE',payload:{session:{schemaVersion:1,sessionId:'long34',revision:1,savedAt:new Date().toISOString(),snapshot},candidateSnapshot:null,corrupted:false,isReadOnly:false}});
    window.testFs = makeDirectory();
  });
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  fs.mkdirSync('.impeccable/review', {recursive:true});
  await page.setViewport({width:1280,height:900});
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  assert.equal(await page.$eval('[data-testid="image-continue"]', el => el.disabled), true);
  console.log('界面计算样式：', await page.$eval('[data-testid="unlocalized-dialog"]', el => ({
    bodyFont:getComputedStyle(document.body).fontFamily,
    dialogFont:getComputedStyle(el).fontFamily,
    invalidColor:getComputedStyle(el.querySelector('.unlocalized-invalid')).color,
    token:getComputedStyle(document.documentElement).getPropertyValue('--vermilion'),
  })));

  assert.equal(await page.evaluate(() => testFs.writes.length), 0);
  for (const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]) {
    await page.setViewport({width,height});
    const geometry = await page.$eval('[data-testid="unlocalized-dialog"]', el => {
      const body = el.querySelector('.export-dialog-body');
      const footer = el.querySelector('.export-dialog-footer').getBoundingClientRect();
      return {overflow:el.scrollWidth > el.clientWidth, scrollable:body.scrollHeight>body.clientHeight, footerVisible:footer.bottom<=innerHeight};
    });
    assert.deepEqual(geometry,{overflow:false,scrollable:true,footerVisible:true});
    await page.screenshot({path:`.impeccable/review/${name}.png`});
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlocalized-dialog"]'));
  await page.evaluate(() => __wetrim.blockListRef.current.setFilter('excluded'));
  await page.click('[data-testid="action-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  await page.click('[data-testid="image-locate"]');
  await page.waitForSelector('[data-block-id="b0"] textarea');
  assert.equal(await page.evaluate(() => __wetrim.blockListRef.current.getFilter()), 'all');
  console.log('✓ 无效地址禁用继续、长清单、窄屏、筛选隐藏目标的定位');
  const allRecovered = await page.evaluate(async () => {
    const fs = makeDirectory(); let retry = false;
    const res = await __wetrim.writeArticleDirectory(fs.root, makeSnapshot(['![图](https://mmbiz.qpic.cn/recover)']), {
      fetchFn: async () => retry ? pngFetch() : new Response('', {status:403}),
      onUnlocalized: async () => {retry = true; return 'retry';},
    });
    return {ok:res.ok, failed:res.failedImagesCount, count:fs.writes.length};
  });
  assert.deepEqual(allRecovered, {ok:true,failed:0,count:4});
  const writeFailure = await page.evaluate(async () => {
    const fs = makeDirectory();
    const snapshot = makeSnapshot(['正文']);
    const old = fs.root.getDirectoryHandle;
    let fail = true;
    fs.root.getDirectoryHandle = async (name, options) => {
      const dir = await old(name, options);
      if (fail) return {...dir, getFileHandle:async () => {throw new Error('磁盘已满');}};
      return dir;
    };
    const first = await __wetrim.writeArticleDirectory(fs.root, snapshot);
    fail = false;
    const second = await __wetrim.writeArticleDirectory(fs.root, snapshot);
    return {first:{ok:first.ok,dir:first.attemptedDirName,stage:first.stage},second:{ok:second.ok,dir:second.articleDirName}};
  });
  assert.deepEqual(writeFailure,{first:{ok:false,dir:'图片导出测试',stage:'write_file'},second:{ok:true,dir:'图片导出测试 (2)'}});
  console.log('✓ 重试全部恢复、写入失败说明残留及重试创建新目录');
  await page.click('[data-testid="action-preview"]');
  await page.click('[data-testid="preview-btn-export"]');
  await page.waitForSelector('[data-testid="unlocalized-dialog"][open]');
  assert.equal(await page.$eval('[data-testid="image-back"]', el=>el===document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlocalized-dialog"]') && !document.querySelector('[data-testid="preview-dialog"][open]'));
  assert.equal(await page.evaluate(() => testFs.writes.length), 0);
  assert.equal(await page.evaluate(() => permissionRequests), 0);
  console.log('✓ 键盘返回编辑、取消本次导出，全程没有申请新权限');






} finally {
  await browser.close();
}
