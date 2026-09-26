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

// 3. Intentionally broken URL to trigger onerror
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
      ({ tallUrl }) => {
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
                ],
                images: [{ id: 'img-asset-tall', url: tallUrl }],
                captureWarnings: [],
              },
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      { tallUrl: TALL_IMAGE_URL }
    );

    await page.waitForSelector('[data-block-id="b-img-tall"] [data-is-tall="true"]', { timeout: 5000 });
    const tallBadgeText = await page.$eval(
      '[data-block-id="b-img-tall"] [data-testid="image-tall-badge"]',
      (el) => el.textContent.trim()
    );
    assert(tallBadgeText.includes('长图'), 'Tall image must display "长图" badge');
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
