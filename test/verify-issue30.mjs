import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

// SVG Data URIs for offline, stable image testing
// 1. Normal proportion SVG (400x300)
const NORMAL_IMAGE_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMzAwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iIzJmNWZhOCIvPjx0ZXh0IHg9IjIwMCIgeT0iMTUwIiBmaWxsPSIjZmZmZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjI0Ij5Ob3JtYWwgSW1hZ2U8L3RleHQ+PC9zdmc+';

// 2. Ultra-tall vertical SVG (200x800, ratio 4:1)
const TALL_IMAGE_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iODAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZmE5ZDNiIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjYzgzNTJiIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjIwMCIgaGVpZ2h0PSI4MDAiIGZpbGw9InVybCgjZykiLz48dGV4dCB4PSIxMDAiIHk9IjUwIiBmaWxsPSIjZmZmZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjE4Ij5UYWxsIFRvcDwvdGV4dD48dGV4dCB4PSIxMDAiIHk9Ijc1MCIgZmlsbD0iI2ZmZmZmZiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxOCI+VGFsbCBCb3R0b208L3RleHQ+PC9zdmc+';

// 3. High-res landscape SVG (1920x1080)：缩放后显示高度远低于原图高度，但不是长图
const WIDE_IMAGE_URL =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#2f5fa8"/></svg>');

// 4. Intentionally broken URL to trigger onerror
const BROKEN_IMAGE_URL = 'https://invalid-nonexistent-mmbiz.test.local/broken/image/photo_2026?wx_fmt=png&wxfrom=5';

async function run() {
  console.log('==> Starting Issue #30 Verification (Image Presentation, Thumbnails & Conversion Notes)...');

  // --------------------------------------------------------------------------
  // Test 1: CI DOM access check rule outside BlockList
  // --------------------------------------------------------------------------
  console.log('\n--- Test 1: CI DOM access check rule outside BlockList ---');
  const domCheckPassed = checkDomAccess();
  assert.strictEqual(domCheckPassed, true, 'check-dom-access.mjs must pass with 0 violations in src/app');
  console.log('✓ Test 1 Passed: No direct DOM queries outside BlockList in src/app');

  // --------------------------------------------------------------------------
  // Launch Chrome Extension with Puppeteer
  // --------------------------------------------------------------------------
  const distDir = path.resolve('dist');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [distDir],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page;
  try {
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().includes('background.js'),
      { timeout: 10000 }
    );
    const worker = await workerTarget.worker();
    const extId = await worker.evaluate(() => chrome.runtime.id);
    console.log(`==> Extension loaded with ID: ${extId}`);

    page = await browser.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      // Filter out expected failed network logs for broken image test
      if (!text.includes('net::ERR_NAME_NOT_RESOLVED') && !text.includes('Failed to load resource')) {
        console.log('[Browser Console]', text);
      }
    });
    page.on('pageerror', (err) => console.log('[Browser Page Error]', err));
    await page.setViewport({ width: 1200, height: 800 });

    const appUrl = `chrome-extension://${extId}/app.html`;
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 2: Normal Image Rendering & Attributes
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Normal image rendering with remote URL, lazy loading & max-height ---');
    await page.evaluate(
      ({ normalUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-test',
              revision: 1,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-sample',
                  title: '图片呈现测试文章',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-img-1',
                    order: 1,
                    type: 'image',
                    originalHtml: `<p><img src="${normalUrl}" alt="普通比例插图"></p>`,
                    initialMarkdown: `![普通比例插图](${normalUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                ],
                images: [{ id: 'img-asset-1', url: normalUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { normalUrl: NORMAL_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-img-1"] [data-testid="image-thumbnail-img"]', {
      timeout: 5000,
    });

    const imgAttrs = await page.evaluate(() => {
      const img = document.querySelector('[data-block-id="b-img-1"] [data-testid="image-thumbnail-img"]');
      const box = document.querySelector('[data-block-id="b-img-1"] [data-testid="image-thumbnail-box"]');
      const computed = window.getComputedStyle(box);
      return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        loading: img.getAttribute('loading'),
        decoding: img.getAttribute('decoding'),
        maxHeight: computed.maxHeight,
        cursor: computed.cursor,
      };
    });

    assert.strictEqual(imgAttrs.src, NORMAL_IMAGE_URL, 'Image src must directly match remote URL');
    assert.strictEqual(imgAttrs.alt, '普通比例插图', 'Image alt must match markdown alt');
    assert.strictEqual(imgAttrs.loading, 'lazy', 'Image must have loading="lazy"');
    assert.strictEqual(imgAttrs.decoding, 'async', 'Image must have decoding="async"');
    assert(parseFloat(imgAttrs.maxHeight) <= 480, 'Thumbnail box maxHeight must be constrained to <= 480px / half screen');
    assert.strictEqual(imgAttrs.cursor, 'pointer', 'Thumbnail box must have pointer cursor');
    console.log('✓ Test 2 Passed: Normal image rendered with remote URL, lazy loading, and max-height constraint');

    // --------------------------------------------------------------------------
    // Test 3: Tall Image (超长竖图) Detection & Fade Badge
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Tall image detection, bottom fade & "长图" badge ---');
    await page.evaluate(
      ({ tallUrl, wideUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-test',
              revision: 2,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-sample',
                  title: '图片呈现测试文章',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-img-tall',
                    order: 1,
                    type: 'image',
                    originalHtml: `<p><img src="${tallUrl}" alt="长竖版信息图"></p>`,
                    initialMarkdown: `![长竖版信息图](${tallUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                  {
                    id: 'b-img-wide',
                    order: 2,
                    type: 'image',
                    originalHtml: `<p><img src="${wideUrl}" alt="高清横图"></p>`,
                    initialMarkdown: `![高清横图](${wideUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                ],
                images: [
                  { id: 'img-asset-tall', url: tallUrl },
                  { id: 'img-asset-wide', url: wideUrl },
                ],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { tallUrl: TALL_IMAGE_URL, wideUrl: WIDE_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-img-tall"] [data-is-tall="true"]', { timeout: 5000 });
    const tallBadgeText = await page.$eval(
      '[data-block-id="b-img-tall"] [data-testid="image-tall-badge"]',
      (el) => el.textContent.trim()
    );
    assert(tallBadgeText.includes('长图'), 'Tall image must display "长图" badge');

    // 长图只显示顶部：图片按宽度铺开，渲染高度超过被限高的盒子，底部被裁掉
    const tallGeometry = await page.$eval('[data-block-id="b-img-tall"]', (blockEl) => {
      const box = blockEl.querySelector('[data-testid="image-thumbnail-box"]').getBoundingClientRect();
      const img = blockEl.querySelector('[data-testid="image-thumbnail-img"]').getBoundingClientRect();
      return { boxTop: box.top, boxHeight: box.height, imgTop: img.top, imgHeight: img.height, imgWidth: img.width };
    });
    assert(tallGeometry.imgHeight > tallGeometry.boxHeight + 1, 'Tall image must be cropped by the box (only top visible)');
    assert(Math.abs(tallGeometry.imgTop - tallGeometry.boxTop) <= 2, 'Tall image must be anchored to the top of the box');
    assert(Math.abs(tallGeometry.imgWidth - 200) <= 1, 'Tall image must keep its natural width instead of being shrunk');

    // 高清横图缩放后虽然远矮于原图，但不是长图
    await page.waitForSelector('[data-block-id="b-img-wide"] [data-image-status="loaded"]', { timeout: 5000 });
    const wideIsTall = await page.$eval(
      '[data-block-id="b-img-wide"] [data-testid="image-presentation"]',
      (el) => el.getAttribute('data-is-tall')
    );
    assert.strictEqual(wideIsTall, 'false', 'High-res landscape image must NOT be marked as tall');
    console.log(`✓ Test 3 Passed: Tall image detected, badge displayed: "${tallBadgeText}"`);

    // --------------------------------------------------------------------------
    // Test 4: Full Size Image Viewer Overlay ("看原图" 浮层)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Image viewer modal opening, Esc closing, and focus retention ---');
    // Click thumbnail box to open modal
    await page.click('[data-block-id="b-img-tall"] [data-testid="image-thumbnail-box"]');
    await page.waitForSelector('[data-testid="image-viewer-overlay"]', { timeout: 3000 });

    const modalImgSrc = await page.$eval(
      '[data-testid="image-viewer-full-img"]',
      (el) => el.getAttribute('src')
    );
    assert.strictEqual(modalImgSrc, TALL_IMAGE_URL, 'Modal full image src must match target image');

    // Press Escape to close modal
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="image-viewer-overlay"]', { hidden: true, timeout: 3000 });

    // Focus must return to thumbnail container
    const isFocusedOnThumbnail = await page.evaluate(() => {
      const thumb = document.querySelector('[data-block-id="b-img-tall"] [data-testid="image-thumbnail-box"]');
      return document.activeElement === thumb;
    });
    assert.strictEqual(isFocusedOnThumbnail, true, 'Focus must return to thumbnail trigger after closing viewer');

    // Test opening with keyboard Enter
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="image-viewer-overlay"]', { timeout: 3000 });
    console.log('✓ Keyboard Enter opened viewer modal successfully');

    // Click close button
    await page.click('[data-testid="image-viewer-close-btn"]');
    await page.waitForSelector('[data-testid="image-viewer-overlay"]', { hidden: true, timeout: 3000 });
    console.log('✓ Test 4 Passed: Image viewer modal open, close, and focus retention verified');

    // --------------------------------------------------------------------------
    // Test 5: Image Load Failure & In-place Placeholder
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Image load failure in-place placeholder, domain, truncated URL, and unblocked text editing ---');
    await page.evaluate(
      ({ brokenUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-test',
              revision: 3,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-sample',
                  title: '图片呈现测试文章',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-img-broken',
                    order: 1,
                    type: 'image',
                    originalHtml: `<p><img src="${brokenUrl}" alt="失效图片"></p>`,
                    initialMarkdown: `![失效图片](${brokenUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                  {
                    id: 'b-text-2',
                    order: 2,
                    type: 'paragraph',
                    originalHtml: `<p>后续正文段落，文字编辑绝不应被前图失败阻断。</p>`,
                    initialMarkdown: `后续正文段落，文字编辑绝不应被前图失败阻断。`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                ],
                images: [{ id: 'img-asset-broken', url: brokenUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { brokenUrl: BROKEN_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-img-broken"] [data-testid="image-error-card"]', {
      timeout: 10000,
    });

    const errorDetails = await page.evaluate(() => {
      const card = document.querySelector('[data-block-id="b-img-broken"] [data-testid="image-error-card"]');
      const title = card.querySelector('.image-error-title')?.textContent?.trim();
      const domain = card.querySelector('.image-error-domain')?.textContent?.trim();
      const pathText = card.querySelector('.image-error-path')?.textContent?.trim();
      const retryBtn = card.querySelector('[data-testid="image-retry-btn"]')?.textContent?.trim();
      return { title, domain, pathText, retryBtn };
    });

    assert.strictEqual(errorDetails.title, '图片没有加载出来', 'Must show exact copy "图片没有加载出来"');
    assert.strictEqual(errorDetails.domain, 'invalid-nonexistent-mmbiz.test.local', 'Must display parsed domain');
    assert(errorDetails.pathText.includes('broken/image'), 'Must display truncated URL path');
    assert.strictEqual(errorDetails.retryBtn, '重试', 'Must display "重试" button');

    // Verify text editing is NOT blocked in subsequent block
    await page.click('[data-block-id="b-text-2"] [data-testid="block-action-edit"]');
    await page.waitForSelector('[data-block-id="b-text-2"] [data-testid="block-editor-textarea"]', { timeout: 3000 });
    await page.type('[data-block-id="b-text-2"] [data-testid="block-editor-textarea"]', '【编辑追加】');
    await page.click('[data-block-id="b-text-2"] [data-testid="block-action-finish-edit"]');
    const updatedText = await page.$eval('[data-block-id="b-text-2"] [data-testid="block-rendered-content"]', (el) => el.textContent);
    assert(updatedText.includes('【编辑追加】'), 'Subsequent block must be fully editable even when previous image fails');

    // Verify image markdown reference was NOT deleted
    const sessionMd = await page.evaluate(() => {
      const b = window.__wetrim.getState()?.session?.snapshot.blocks[0];
      return b?.initialMarkdown;
    });
    assert.strictEqual(sessionMd, `![失效图片](${BROKEN_IMAGE_URL})`, 'Image failure must not delete or modify markdown reference');
    console.log('✓ Test 5 Passed: Image failure placeholder, domain, truncated URL, and unblocked editing verified');

    // --------------------------------------------------------------------------
    // Test 6: Image Retry Behavior
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Image retry behavior ("正在重试…") and DOM src reset ---');
    const retryBtn = await page.$('[data-block-id="b-img-broken"] [data-testid="image-retry-btn"]');
    await retryBtn.click();

    // While retrying, text must show "正在重试…"
    const retryingText = await page.$eval(
      '[data-block-id="b-img-broken"] [data-testid="image-retry-btn"]',
      (el) => el.textContent.trim()
    );
    assert.strictEqual(retryingText, '正在重试…', 'Retry button must show "正在重试…" while retrying');

    // 重试必须真正发出请求并落到终态：地址仍然无效，应回到失败态，而不是停在「正在重试…」
    await page.waitForSelector('[data-block-id="b-img-broken"] [data-image-status="error"]', { timeout: 10000 });
    const afterRetry = await page.evaluate((brokenUrl) => {
      const btn = document.querySelector('[data-block-id="b-img-broken"] [data-testid="image-retry-btn"]');
      const img = document.querySelector('[data-block-id="b-img-broken"] [data-testid="image-thumbnail-img"]');
      const block = window.__wetrim.getState().session.snapshot.blocks.find((b) => b.id === 'b-img-broken');
      return {
        btnText: btn?.textContent?.trim(),
        imgSrc: img?.getAttribute('src'),
        markdownKept: (block.editedMarkdown ?? block.initialMarkdown).includes(brokenUrl),
      };
    }, BROKEN_IMAGE_URL);
    assert.strictEqual(afterRetry.btnText, '重试', 'Retry button must return to "重试" after the retry fails again');
    assert.strictEqual(afterRetry.imgSrc, BROKEN_IMAGE_URL, 'Retry must keep the same src');
    assert.strictEqual(afterRetry.markdownKept, true, 'Retry must not change the saved markdown address');
    console.log('✓ Test 6 Passed: Retry button shows "正在重试…" and resets DOM src without changing markdown');

    // --------------------------------------------------------------------------
    // Test 7: Collapsed Image Summary
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Collapsed image summary (mini thumbnail, alt text, no raw ![](...) url) ---');
    await page.evaluate(
      ({ normalUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-test',
              revision: 4,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-sample',
                  title: '图片呈现测试文章',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-img-collapsed',
                    order: 1,
                    type: 'image',
                    originalHtml: `<p><img src="${normalUrl}" alt="封面大图"></p>`,
                    initialMarkdown: `![封面大图](${normalUrl})`,
                    editedMarkdown: null,
                    included: false, // Collapsed
                    notes: [{ code: 'table-degraded', message: '表格已降级' }],
                  },
                ],
                images: [{ id: 'img-asset-1', url: normalUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { normalUrl: NORMAL_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-img-collapsed"][data-block-collapsed="true"]', { timeout: 5000 });

    const collapsedSummary = await page.evaluate(() => {
      const thumb = document.querySelector('[data-block-id="b-img-collapsed"] [data-testid="block-collapsed-thumb"]');
      const alt = document.querySelector('[data-block-id="b-img-collapsed"] [data-testid="block-collapsed-alt"]');
      const fullSummaryText = document.querySelector('[data-block-id="b-img-collapsed"] .block-collapsed-summary-bar')?.textContent;
      const marker = document.querySelector('[data-block-id="b-img-collapsed"] [data-testid="block-margin-note-markers"]');
      return {
        thumbSrc: thumb?.getAttribute('src'),
        thumbWidth: thumb?.clientWidth,
        thumbHeight: thumb?.clientHeight,
        altText: alt?.textContent?.trim(),
        fullSummaryText,
        hasMarginMarker: Boolean(marker),
      };
    });

    assert.strictEqual(collapsedSummary.thumbSrc, NORMAL_IMAGE_URL, 'Collapsed summary must render mini thumbnail');
    assert.strictEqual(collapsedSummary.altText, '封面大图', 'Collapsed summary must display alt text');
    assert(!collapsedSummary.fullSummaryText.includes('![](data:image'), 'Must NOT display raw ![](url) markdown');
    assert.strictEqual(collapsedSummary.hasMarginMarker, true, 'Margin note marker must be preserved in collapsed state');
    console.log('✓ Test 7 Passed: Collapsed image summary rendered line-height thumbnail, alt text, and preserved margin marker');

    // --------------------------------------------------------------------------
    // Test 8: Conversion Notes & Design Tokens
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Conversion notes design tokens, left margin track placement, and mobile fallback ---');
    await page.evaluate(() => {
      window.__wetrim.dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-issue30-notes',
            revision: 5,
            savedAt: new Date().toISOString(),
            snapshot: {
              snapshotId: 'snap-issue30',
              capturedAt: new Date().toISOString(),
              source: {
                url: 'https://mp.weixin.qq.com/s/issue30-notes',
                title: '转换提示测试',
                account: '测试号',
                publishedAt: '2026-09-26',
              },
              blocks: [
                {
                  id: 'b-note-1',
                  order: 1,
                  type: 'table',
                  originalHtml: `<table><tr><td>1</td></tr></table>`,
                  initialMarkdown: `| 列1 |\n| --- |\n| 1 |`,
                  editedMarkdown: null,
                  included: true,
                  notes: [{ code: 'table-degraded', message: '复杂表格已降级为可读文本' }],
                },
                {
                  id: 'b-note-2',
                  order: 2,
                  type: 'richMedia',
                  originalHtml: `<mpvoice name="音频"></mpvoice>`,
                  initialMarkdown: `【音频】音频`,
                  editedMarkdown: null,
                  included: true,
                  notes: [{ code: 'richmedia-placeholder', message: '富媒体卡片已转换为占位说明' }],
                },
                {
                  id: 'b-note-3',
                  order: 3,
                  type: 'unknown',
                  originalHtml: `<unsupported>未知</unsupported>`,
                  initialMarkdown: `> 【未识别内容】`,
                  editedMarkdown: null,
                  included: true,
                  notes: [{ code: 'convert-failed', message: '该内容块无法转换，已降级保留原始 HTML 记录' }],
                },
              ],
              images: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    });

    await page.waitForSelector('[data-block-id="b-note-1"] [data-testid="block-margin-note-markers"]', { timeout: 5000 });

    const noteBadges = await page.evaluate(() => {
      const getMarkerText = (id) =>
        document.querySelector(`[data-block-id="${id}"] .margin-note-marker`)?.textContent?.trim();
      const getNoteBadgeText = (id) =>
        document.querySelector(`[data-block-id="${id}"] .note-badge`)?.textContent?.trim();
      const getAriaDescribedBy = (id) =>
        document.querySelector(`[data-block-id="${id}"]`)?.getAttribute('aria-describedby');

      return {
        tableMarker: getMarkerText('b-note-1'),
        tableBadge: getNoteBadgeText('b-note-1'),
        tableAria: getAriaDescribedBy('b-note-1'),

        richMarker: getMarkerText('b-note-2'),
        richBadge: getNoteBadgeText('b-note-2'),

        failMarker: getMarkerText('b-note-3'),
        failBadge: getNoteBadgeText('b-note-3'),
      };
    });

    assert.strictEqual(noteBadges.tableMarker, '降级', 'table-degraded marker must be "降级"');
    assert.strictEqual(noteBadges.tableBadge, '降级', 'table-degraded note badge must be "降级"');
    assert.strictEqual(noteBadges.tableAria, 'block-notes-b-note-1', 'Must have aria-describedby linking to block notes');

    assert.strictEqual(noteBadges.richMarker, '占位', 'richmedia-placeholder marker must be "占位"');
    assert.strictEqual(noteBadges.richBadge, '占位', 'richmedia-placeholder note badge must be "占位"');

    assert.strictEqual(noteBadges.failMarker, '未转换', 'convert-failed marker must be "未转换"');
    assert.strictEqual(noteBadges.failBadge, '未转换', 'convert-failed note badge must be "未转换"');
    console.log('✓ Desktop note badges, labels and aria-describedby verified');

    // Test mobile layout (<= 720px)
    await page.setViewport({ width: 500, height: 800 });
    const mobileLayout = await page.evaluate(() => {
      const marginTrack = document.querySelector('.margin-track');
      const trackComputed = window.getComputedStyle(marginTrack);
      const marker = document.querySelector('[data-block-id="b-note-1"] .block-margin-note-markers');
      const markerComputed = window.getComputedStyle(marker);
      return {
        marginTrackDisplay: trackComputed.display,
        markerPosition: markerComputed.position,
      };
    });

    assert.strictEqual(mobileLayout.marginTrackDisplay, 'none', 'Margin track must be hidden on screens <= 720px');
    assert.strictEqual(mobileLayout.markerPosition, 'static', 'Markers must fall back inline (position: static) on mobile');
    console.log('✓ Mobile responsive layout (margin track hidden, markers inline under meta) verified');

    // Restore desktop viewport
    await page.setViewport({ width: 1200, height: 800 });

    // --------------------------------------------------------------------------
    // Test 9: Shared Image Resources
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Shared image resource integrity across multiple blocks ---');
    await page.evaluate(
      ({ normalUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-shared',
              revision: 6,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-shared',
                  title: '共享图片测试',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-shared-1',
                    order: 1,
                    type: 'image',
                    originalHtml: `<p><img src="${normalUrl}" alt="共享图片块1"></p>`,
                    initialMarkdown: `![共享图片块1](${normalUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                  {
                    id: 'b-shared-2',
                    order: 2,
                    type: 'image',
                    originalHtml: `<p><img src="${normalUrl}" alt="共享图片块2"></p>`,
                    initialMarkdown: `![共享图片块2](${normalUrl})`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                ],
                images: [{ id: 'img-asset-1', url: normalUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { normalUrl: NORMAL_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-shared-1"]', { timeout: 5000 });

    // Exclude the first block
    await page.click('[data-block-id="b-shared-1"] [data-testid="block-action-exclude"]');
    await page.waitForSelector('[data-block-id="b-shared-1"][data-block-collapsed="true"]', { timeout: 3000 });

    // Verify second block still has its full thumbnail rendered
    const secondBlockImgSrc = await page.$eval(
      '[data-block-id="b-shared-2"] [data-testid="image-thumbnail-img"]',
      (img) => img.getAttribute('src')
    );
    assert.strictEqual(secondBlockImgSrc, NORMAL_IMAGE_URL, 'Second block must retain its image thumbnail unchanged');
    console.log('✓ Test 9 Passed: Shared image resources remain intact when another block is excluded');

    // --------------------------------------------------------------------------
    // Test 10: Scroll Anchoring on Image Load
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: Scroll anchoring verification ---');
    const scrollAnchoringRules = await page.evaluate(() => {
      const content = document.querySelector('.block-rendered-content');
      const stream = document.querySelector('.block-items-stream');
      const sheet = document.querySelector('.proof-sheet');
      return {
        content: content ? window.getComputedStyle(content).overflowAnchor : 'auto',
        stream: stream ? window.getComputedStyle(stream).overflowAnchor : 'auto',
        sheet: sheet ? window.getComputedStyle(sheet).overflowAnchor : 'auto',
      };
    });
    assert.notStrictEqual(scrollAnchoringRules.content, 'none', 'overflow-anchor must not be disabled on content');
    assert.notStrictEqual(scrollAnchoringRules.stream, 'none', 'overflow-anchor must not be disabled on block items stream');
    console.log('✓ Test 10 Passed: Scroll anchoring rules verified');

    // --------------------------------------------------------------------------
    // Test 11: Inline Style Parsing & Collapsed aria-describedby Verification
    // --------------------------------------------------------------------------
    console.log('\n--- Test 11: Inline style parsing in html-to-react & collapsed aria-describedby ---');
    await page.evaluate(
      ({ normalUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-inline-style',
              revision: 7,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30-style',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-style',
                  title: '内联样式与折叠无障碍测试',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-style-1',
                    order: 1,
                    type: 'image',
                    originalHtml: `<div style="text-align: center; margin: 12px 0;"><img src="${normalUrl}" alt="居中图片" /></div>`,
                    initialMarkdown: `<div style="text-align: center; margin: 12px 0;"><img src="${normalUrl}" alt="居中图片" /></div>`,
                    editedMarkdown: null,
                    included: true,
                    notes: [
                      {
                        code: 'richmedia-placeholder',
                        message: '该图片附带富媒体样式',
                      },
                    ],
                  },
                ],
                images: [{ id: 'img-asset-1', url: normalUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { normalUrl: NORMAL_IMAGE_URL }
    );

    // Verify block with inline style renders without React errors
    await page.waitForSelector('[data-block-id="b-style-1"] [data-testid="image-thumbnail-img"]', {
      timeout: 5000,
    });
    const renderedStyleAlign = await page.$eval(
      '[data-block-id="b-style-1"] [data-testid="block-rendered-content"] div',
      (el) => el.style.textAlign
    );
    assert.strictEqual(renderedStyleAlign, 'center', 'Inline style textAlign must be safely parsed and applied');

    // Exclude to test collapsed aria-describedby target
    await page.click('[data-block-id="b-style-1"] [data-testid="block-action-exclude"]');
    await page.waitForSelector('[data-block-id="b-style-1"][data-block-collapsed="true"]', { timeout: 3000 });

    const collapsedDescribedBy = await page.evaluate(() => {
      const blockEl = document.querySelector('[data-block-id="b-style-1"]');
      const descId = blockEl.getAttribute('aria-describedby');
      const descEl = descId ? document.getElementById(descId) : null;
      return {
        descId,
        hasDescElement: !!descEl,
        descText: descEl ? descEl.textContent : '',
      };
    });

    assert.strictEqual(collapsedDescribedBy.descId, 'block-notes-b-style-1', 'Collapsed block must have aria-describedby');
    assert.strictEqual(collapsedDescribedBy.hasDescElement, true, 'aria-describedby target element must exist in DOM during collapsed state');
    assert(collapsedDescribedBy.descText.includes('富媒体样式'), 'Collapsed sr description must contain note message');
    console.log('✓ Test 11 Passed: Inline styles safely rendered and collapsed aria-describedby verified');

    // --------------------------------------------------------------------------
    // Test 12: Search highlights stay aligned in blocks with images; task list checkboxes survive
    // --------------------------------------------------------------------------
    console.log('\n--- Test 12: Search highlight alignment with image UI text & boolean attributes ---');
    await page.evaluate(
      ({ brokenUrl, normalUrl }) => {
        window.__wetrim.dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-issue30-search',
              revision: 8,
              savedAt: new Date().toISOString(),
              snapshot: {
                snapshotId: 'snap-issue30-search',
                capturedAt: new Date().toISOString(),
                source: {
                  url: 'https://mp.weixin.qq.com/s/issue30-search',
                  title: '图片与搜索高亮测试',
                  account: '测试号',
                  publishedAt: '2026-09-26',
                },
                blocks: [
                  {
                    id: 'b-search-img',
                    order: 1,
                    type: 'paragraph',
                    originalHtml: `<p><img src="${brokenUrl}"> 图后正文里的甲乙丙</p>`,
                    initialMarkdown: `![](${brokenUrl}) 图后正文里的甲乙丙`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                  {
                    id: 'b-task-list',
                    order: 2,
                    type: 'list',
                    originalHtml: '<ul><li>已完成</li></ul>',
                    initialMarkdown: `- [x] 已完成 ![](${normalUrl})\n- [ ] 未完成`,
                    editedMarkdown: null,
                    included: true,
                    notes: [],
                  },
                ],
                images: [
                  { id: 'img-asset-broken', url: brokenUrl },
                  { id: 'img-asset-1', url: normalUrl },
                ],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { brokenUrl: BROKEN_IMAGE_URL, normalUrl: NORMAL_IMAGE_URL }
    );

    // 等失败卡片注入界面文字后再搜索，才能覆盖偏移错位的场景
    await page.waitForSelector('[data-block-id="b-search-img"] [data-image-status="error"]', { timeout: 10000 });
    await page.type('[data-testid="search-input"]', '甲乙丙');
    await page.waitForFunction(
      () => CSS.highlights.get('search-hit-current')?.size === 1,
      { timeout: 5000 }
    );
    const highlightedText = await page.evaluate(() => [...CSS.highlights.get('search-hit-current')][0].toString());
    assert.strictEqual(highlightedText, '甲乙丙', 'Highlight must cover exactly the matched text, not shifted by image UI text');
    await page.click('[data-testid="search-clear-btn"]');

    const checkboxes = await page.$$eval(
      '[data-block-id="b-task-list"] input[type="checkbox"]',
      (els) => els.map((el) => ({ checked: el.checked, disabled: el.disabled }))
    );
    assert.deepStrictEqual(
      checkboxes,
      [
        { checked: true, disabled: true },
        { checked: false, disabled: true },
      ],
      'Task list checkboxes in blocks with images must keep checked/disabled state'
    );
    console.log('✓ Test 12 Passed: Search highlight aligned and boolean attributes preserved');

    console.log('\n=============================================');
    console.log('✓ All Issue #30 acceptance criteria verified successfully!');
    console.log('=============================================\n');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
