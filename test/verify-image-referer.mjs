import puppeteer from 'puppeteer';
import path from 'path';

/**
 * 实测扩展全页加载 mmbiz 图片时实际发出的 Referer，以及渲染出的是真图还是防盗链占位图。
 *
 * 背景（Issue #30 设计简报 §7）：mmbiz 对外站 Referer 返回 200 的 140×140 JPEG
 * 「此图片来自微信公众平台 未经允许不可引用」，不会触发 onerror。
 *
 * 场景：
 *   A. 清洗页经 BlockItem 真实渲染的图片块（当前实现的代码路径）
 *   C. 同页 fetch()（导出取字节的路径，只记录不断言）
 *
 * 断言：app.html 声明 <meta name="referrer" content="no-referrer">；A 渲染出的必须是真图，不是 140×140 占位图。
 * 依赖外网访问 mmbiz.qpic.cn；样例图失效时需换一张真实图片地址。
 *
 * 红灯自检：`node test/verify-image-referer.mjs --force-referer=https://example.com/`
 * 强制带外站 Referer，此时应识别出占位图并以 1 退出。
 */

const IMAGE_URL =
  'https://mmbiz.qpic.cn/mmbiz_png/yR4znsxMmpkwNYI4A1gggl4zFIsRicicAKZSZjZRSdKNAlicK7VXo9uGhACUAT0UicfYhGdibOEkyknc5uJTFQb6QuibpyEhdhDibiaibfgWNCP4Byn4/640?wx_fmt=png&from=appmsg';
const FORCE_REFERER = process.argv.find((a) => a.startsWith('--force-referer='))?.split('=')[1] ?? null;
const PLACEHOLDER = { w: 140, h: 140 };

function isPlaceholder(size) {
  return size.w === PLACEHOLDER.w && size.h === PLACEHOLDER.h;
}

async function run() {
  const distDir = path.resolve('dist');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [distDir],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let failed = false;
  try {
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
      { timeout: 10000 }
    );
    const extId = await (await workerTarget.worker()).evaluate(() => chrome.runtime.id);

    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    // 红灯自检：强制带外站 Referer，确认脚本能识别出占位图
    if (FORCE_REFERER) {
      await cdp.send('Network.setExtraHTTPHeaders', {
        headers: { Referer: FORCE_REFERER },
      });
    }

    // requestId → { initiator, referer(extraInfo), status, mime, length }
    const requests = new Map();
    const entry = (id) => {
      if (!requests.has(id)) requests.set(id, {});
      return requests.get(id);
    };
    cdp.on('Network.requestWillBeSent', (e) => {
      if (!e.request.url.includes('mmbiz.qpic.cn')) return;
      const r = entry(e.requestId);
      r.type = e.type;
      r.policy = e.request.referrerPolicy;
      r.refererFromRequest = e.request.headers.Referer ?? null;
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
      const r = requests.get(e.requestId);
      if (!r) {
        // ExtraInfo 可能先于 requestWillBeSent 到达
        const h = e.headers;
        if (!h[':authority']?.includes('mmbiz') && !(h.Host ?? '').includes('mmbiz')) {
          entry(e.requestId).pendingHeaders = h;
          return;
        }
      }
      entry(e.requestId).wireHeaders = e.headers;
    });
    cdp.on('Network.responseReceived', (e) => {
      if (!e.response.url.includes('mmbiz.qpic.cn')) return;
      const r = entry(e.requestId);
      r.status = e.response.status;
      r.mime = e.response.mimeType;
    });
    cdp.on('Network.loadingFinished', (e) => {
      const r = requests.get(e.requestId);
      if (r) r.bytes = e.encodedDataLength;
    });

    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    const referrerMeta = await page.evaluate(
      () => document.querySelector('meta[name="referrer"]')?.getAttribute('content') ?? null
    );

    // ---- A. 真实渲染路径 ----
    await page.evaluate((url) => {
      window.__wetrim.dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-referer-probe',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              articleId: 'art-referer',
              capturedAt: new Date().toISOString(),
              source: { url: 'https://mp.weixin.qq.com/s/probe', title: 'Referer 实测', account: null, publishedAt: null },
              blocks: [
                {
                  id: 'img-1',
                  order: 1,
                  type: 'image',
                  originalHtml: `<img data-src="${url}">`,
                  initialMarkdown: `![](${url})`,
                  editedMarkdown: null,
                  included: true,
                  notes: [],
                },
              ],
              images: [{ id: 'asset-1', url }],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, IMAGE_URL);

    const waitImg = (selector) =>
      page.waitForFunction(
        (sel) => {
          const img = document.querySelector(sel);
          return img && img.complete ? { w: img.naturalWidth, h: img.naturalHeight } : false;
        },
        { timeout: 20000 },
        selector
      ).then((h) => h.jsonValue());

    const sizeA = await waitImg('[data-testid="block-rendered-content"] img');
    const reqA = [...requests.values()].at(-1);

    // ---- C. fetch()（导出路径），只记录 ----
    const beforeC = requests.size;
    const fetchC = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return { status: res.status, type: res.headers.get('content-type'), bytes: buf.byteLength };
    }, IMAGE_URL);
    const reqC = [...requests.values()].slice(beforeC).at(-1);

    const referer = (r) => {
      if (!r?.wireHeaders) return '(未捕获到线上请求头)';
      const h = r.wireHeaders;
      return h.Referer ?? h.referer ?? '(未发送)';
    };

    console.log(`app.html <meta name="referrer">: ${referrerMeta ?? '(无)'}`);
    console.log(`A 真实渲染  policy=${reqA?.policy}  Referer=${referer(reqA)}  ${reqA?.status} ${reqA?.mime}  natural=${sizeA.w}x${sizeA.h}${isPlaceholder(sizeA) ? '  ← 防盗链占位图' : ''}`);
    console.log(`C fetch()   policy=${reqC?.policy}  Referer=${referer(reqC)}  ${fetchC.status} ${fetchC.type} bytes=${fetchC.bytes}`);

    if (referrerMeta !== 'no-referrer') {
      failed = true;
      console.error('✗ FAIL: app.html 缺少 <meta name="referrer" content="no-referrer">');
    }
    if (isPlaceholder(sizeA)) {
      failed = true;
      console.error('✗ FAIL: 清洗页真实渲染的图片是防盗链占位图（200，onerror 不会触发）');
    } else {
      console.log('✓ PASS: 清洗页真实渲染的图片是真图');
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
