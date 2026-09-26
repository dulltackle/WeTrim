import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';

/**
 * Issue #29 回归：切换筛选时保持阅读位置。
 * 视口上方有被新筛选隐藏的块时，切换后视口中的块须留在原位，而不是随上方块的消失整体上移。
 */
async function run() {
  console.log('==> Issue #29 reading-position regression...');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [path.resolve('dist')],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
      { timeout: 10000 }
    );
    const extId = await (await workerTarget.worker()).evaluate(() => chrome.runtime.id);
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // 120 块，偶数序号剔除：任何位置上方都有大量剔除块
    const blocks = Array.from({ length: 120 }, (_, i) => ({
      id: `b-${i + 1}`,
      order: i + 1,
      type: 'paragraph',
      originalHtml: `<p>第 ${i + 1} 段正文，用来撑出足够的滚动高度。</p>`,
      initialMarkdown: `第 ${i + 1} 段正文，用来撑出足够的滚动高度。`,
      editedMarkdown: null,
      included: (i + 1) % 2 === 1,
      notes: [],
    }));
    await page.evaluate((blocks) => {
      window.__wetrim.dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-29-pos',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              articleId: 'art-29-pos',
              capturedAt: new Date().toISOString(),
              source: { url: 'https://mp.weixin.qq.com/s/pos', title: '阅读位置', account: 'x', publishedAt: '2026-09-25' },
              blocks,
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, blocks);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 120);

    const settle = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
    const topOf = (id) =>
      page.evaluate((id) => document.querySelector(`[data-block-id="${id}"]`)?.getBoundingClientRect().top ?? null, id);

    // 视口内第一个在目标筛选下仍可见的块（未操作过任何块时，它就是阅读位置锚点）
    const firstSurvivingInView = (included) =>
      page.evaluate((included) => {
        // 与 BlockList.queryVisible 同一口径：固定顶栏以下（scroll-margin-top）才算视口内
        const vTop = parseFloat(getComputedStyle(document.querySelector('[data-testid="block-item"]')).scrollMarginTop);
        const el = [...document.querySelectorAll('[data-testid="block-item"]')].find((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > vTop && r.top < innerHeight && (included === null || el.dataset.blockIncluded === String(included));
        });
        return { id: el.dataset.blockId, top: el.getBoundingClientRect().top };
      }, included);

    // 把 b-61 滚到视口 400px 处
    await page.evaluate(() => {
      const r = document.querySelector('[data-block-id="b-61"]').getBoundingClientRect();
      window.scrollBy(0, r.top - 400);
    });
    await settle();

    // 1. 全部 → 保留：视口内首个保留块位置不变
    const anchor1 = await firstSurvivingInView(true);
    await page.click('[data-testid="filter-tab-included"]');
    await settle();
    const after1 = await topOf(anchor1.id);
    console.log(`全部→保留：${anchor1.id} top ${anchor1.top} → ${after1}`);
    assert(Math.abs(after1 - anchor1.top) <= 2, `切到「保留」后 ${anchor1.id} 位置应不变（${anchor1.top} → ${after1}）`);

    // 2. 保留 → 全部：视口内首块位置不变
    const anchor2 = await firstSurvivingInView(null);
    await page.click('[data-testid="filter-tab-all"]');
    await settle();
    const after2 = await topOf(anchor2.id);
    console.log(`保留→全部：${anchor2.id} top ${anchor2.top} → ${after2}`);
    assert(Math.abs(after2 - anchor2.top) <= 2, `切回「全部」后 ${anchor2.id} 位置应不变（${anchor2.top} → ${after2}）`);

    // 3. 刚操作过的块被新筛选滤掉：它之后最近的可见块接替它在视口中的位置
    await page.focus('[data-block-id="b-61"]');
    const focusedTop = await topOf('b-61');
    await page.click('[data-testid="filter-tab-excluded"]');
    await settle();
    const successorTop = await topOf('b-62');
    console.log(`全部→剔除：b-61 top ${focusedTop}，接替的 b-62 top ${successorTop}`);
    assert(Math.abs(successorTop - focusedTop) <= 2, `b-62 应接替 b-61 的位置（${focusedTop} → ${successorTop}）`);

    console.log('✓ Reading position preserved across filter switches');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
