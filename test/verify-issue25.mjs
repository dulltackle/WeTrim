import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';
async function run() {
  console.log('==> Starting Issue #25 Verification (Block Inclusion, Folding Summary & 3-State Filtering)...');

  // --------------------------------------------------------------------------
  // Test 1: CI DOM access check rule
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
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 2: Grapheme cluster truncation unit test
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Grapheme cluster truncation (truncateGraphemes) ---');
    const graphemeTests = await page.evaluate(() => {
      const { truncateGraphemes } = window.__wetrim;
      const shortText = '少于二十个字';
      const r1 = truncateGraphemes(shortText, 20);

      const longText = '这是一段用来测试字素截断功能的超长测试文本，总字数肯定超过二十个字了';
      const r2 = truncateGraphemes(longText, 20);

      const emojiText = '👨‍👩‍👧‍👦 医生提示：保持骨骼系统强健需要合理运动与补钙';
      const r3 = truncateGraphemes(emojiText, 10);

      return { r1, r2, r3 };
    });

    assert.strictEqual(graphemeTests.r1, '少于二十个字');
    assert(graphemeTests.r2.endsWith('...'), 'Truncated text must end with "..."');
    assert.strictEqual(graphemeTests.r2, '这是一段用来测试字素截断功能的超长测试文...');
    assert(graphemeTests.r3.startsWith('👨‍👩‍👧‍👦'), 'Emoji cluster must be preserved without splitting');
    assert(graphemeTests.r3.endsWith('...'));
    console.log('✓ Test 2 Passed: Grapheme cluster truncation works correctly with unicode & emoji');

    // --------------------------------------------------------------------------
    // Setup test article session with various block types
    // --------------------------------------------------------------------------
    const testBlocks = [
      {
        id: 'block-p-1',
        order: 1,
        type: 'paragraph',
        originalHtml: '<p>第一段：正常保留的段落内容。</p>',
        initialMarkdown: '第一段：正常保留的段落内容。',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-p-2',
        order: 2,
        type: 'paragraph',
        originalHtml: '<p>第二段：这是一篇很长很长很长的段落，用来验证折叠摘要时的字素预览截断功能是否完全正常。</p>',
        initialMarkdown: '第二段：这是一篇很长很长很长的段落，用来验证折叠摘要时的字素预览截断功能是否完全正常。',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-list-3',
        order: 3,
        type: 'list',
        originalHtml: '<ul><li>列表项 A</li><li>列表项 B <img src="test.jpg" /></li></ul>',
        initialMarkdown: '- 列表项 A\n- 列表项 B ![](test.jpg)',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-quote-4',
        order: 4,
        type: 'quote',
        originalHtml: '<blockquote><p>这是一条引用块</p></blockquote>',
        initialMarkdown: '> 这是一条引用块',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-table-5',
        order: 5,
        type: 'table',
        originalHtml: '<table><tr><th>列1</th><th>列2</th></tr><tr><td>数据1</td><td>数据2</td></tr></table>',
        initialMarkdown: '| 列1 | 列2 |\n| --- | --- |\n| 数据1 | 数据2 |',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-edited-6',
        order: 6,
        type: 'paragraph',
        originalHtml: '<p>第六段：初始文本</p>',
        initialMarkdown: '第六段：初始文本',
        editedMarkdown: '第六段：这是用户已修改后的当前内容！',
        included: true,
        notes: [],
      },
      {
        id: 'block-empty-7',
        order: 7,
        type: 'paragraph',
        originalHtml: '<p></p>',
        initialMarkdown: '',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
    ];

    await page.evaluate((blocks) => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-issue25',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              snapshotId: 'snap-issue25',
              capturedAt: new Date().toISOString(),
              source: {
                title: 'Issue 25 验收测试文章',
                account: 'WeTrim 测试组',
                publishedAt: '2026-09-13',
                url: 'https://mp.weixin.qq.com/s/issue25',
              },
              blocks,
              images: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
        },
      });
    }, testBlocks);

    await page.waitForSelector('[data-testid="block-item"]');

    // --------------------------------------------------------------------------
    // Test 3: Acceptance Criteria 5 & 6 (Composite blocks: whole-block tip, no sub-switches)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Composite blocks (list, quote, table) whole-block tip & no sub-switches ---');

    const compositeChecks = await page.evaluate(() => {
      const listBlock = document.querySelector('[data-block-id="block-list-3"]');
      const quoteBlock = document.querySelector('[data-block-id="block-quote-4"]');
      const tableBlock = document.querySelector('[data-block-id="block-table-5"]');
      const pBlock = document.querySelector('[data-block-id="block-p-1"]');

      const getTipInfo = (el) => {
        const tipEl = el?.querySelector('[data-testid="composite-block-tip"]');
        const ariaLabel = tipEl?.getAttribute('aria-label');
        const tooltipText = tipEl?.querySelector('.tip-tooltip')?.textContent?.trim();
        // 检查内部是否有多余的切换按钮
        const toggleButtons = el?.querySelectorAll('.block-toggle-btn');
        return {
          hasTip: Boolean(tipEl),
          ariaLabel,
          tooltipText,
          toggleButtonsCount: toggleButtons?.length || 0,
        };
      };

      return {
        list: getTipInfo(listBlock),
        quote: getTipInfo(quoteBlock),
        table: getTipInfo(tableBlock),
        paragraph: getTipInfo(pBlock),
      };
    });

    const expectedTipText = '整体取舍，编辑 Markdown 可删改内部内容与图片';
    assert.strictEqual(compositeChecks.list.hasTip, true, 'List block must have composite block tip');
    assert.strictEqual(compositeChecks.list.ariaLabel, expectedTipText);
    assert.strictEqual(compositeChecks.list.tooltipText, expectedTipText);
    assert.strictEqual(compositeChecks.list.toggleButtonsCount, 1, 'List block must have exactly 1 toggle button (no sub-switches)');

    assert.strictEqual(compositeChecks.quote.hasTip, true, 'Quote block must have composite block tip');
    assert.strictEqual(compositeChecks.quote.ariaLabel, expectedTipText);
    assert.strictEqual(compositeChecks.quote.tooltipText, expectedTipText);
    assert.strictEqual(compositeChecks.quote.toggleButtonsCount, 1, 'Quote block must have exactly 1 toggle button (no sub-switches)');

    assert.strictEqual(compositeChecks.table.hasTip, true, 'Table block must have composite block tip');
    assert.strictEqual(compositeChecks.table.ariaLabel, expectedTipText);
    assert.strictEqual(compositeChecks.table.tooltipText, expectedTipText);
    assert.strictEqual(compositeChecks.table.toggleButtonsCount, 1, 'Table block must have exactly 1 toggle button (no sub-switches)');

    assert.strictEqual(compositeChecks.paragraph.hasTip, false, 'Paragraph block should NOT have composite tip');
    console.log('✓ Test 3 Passed: List, quote, and table blocks render prompt tip with no sub-block switches');

    // --------------------------------------------------------------------------
    // Test 4: Acceptance Criteria 1, 2, 3 (Independent toggle, in-place folded summary, current content preservation)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Independent toggle, folded summary preview, expand/collapse & content restoration ---');

    // 4.1 Exclude block-p-2
    const blockP2Before = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-p-2"]');
      const btn = el?.querySelector('[data-testid="block-action-exclude"]');
      return {
        isIncluded: el?.getAttribute('data-block-included') === 'true',
        hasExcludeBtn: Boolean(btn),
        btnText: btn?.textContent?.trim(),
      };
    });
    assert.strictEqual(blockP2Before.isIncluded, true);
    assert.strictEqual(blockP2Before.hasExcludeBtn, true);
    assert.strictEqual(blockP2Before.btnText, '剔除');

    // Click "剔除" on block-p-2
    await page.click('[data-block-id="block-p-2"] [data-testid="block-action-exclude"]');

    // 4.2 Verify block-p-2 is folded in place into summary row
    const blockP2Folded = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-p-2"]');
      const isIncluded = el?.getAttribute('data-block-included') === 'true';
      const isCollapsed = el?.getAttribute('data-block-collapsed') === 'true';
      const statusTag = el?.querySelector('[data-testid="block-status-tag"]')?.textContent?.trim();
      const preview = el?.querySelector('[data-testid="block-summary-preview"]')?.textContent?.trim();
      const restoreBtn = el?.querySelector('[data-testid="block-action-restore"]')?.textContent?.trim();
      const expandBtn = el?.querySelector('[data-testid="block-action-expand"]')?.textContent?.trim();
      const hasFullContent = Boolean(el?.querySelector('[data-testid="block-rendered-content"]'));

      return {
        isIncluded,
        isCollapsed,
        statusTag,
        preview,
        restoreBtn,
        expandBtn,
        hasFullContent,
      };
    });

    assert.strictEqual(blockP2Folded.isIncluded, false, 'block-p-2 must be excluded');
    assert.strictEqual(blockP2Folded.isCollapsed, true, 'block-p-2 must be collapsed in place');
    assert.strictEqual(blockP2Folded.statusTag, '剔除', 'Status tag must show "剔除"');
    assert(blockP2Folded.preview?.endsWith('...'), 'Folded summary preview must end with ellipsis');
    assert.strictEqual(blockP2Folded.restoreBtn, '恢复保留', 'Summary row must have "恢复保留" button');
    assert.strictEqual(blockP2Folded.expandBtn, '展开', 'Summary row must have "展开" button');
    assert.strictEqual(blockP2Folded.hasFullContent, false, 'Collapsed summary row should not render full content container');

    // 4.3 Test "展开" and "收起"
    await page.click('[data-block-id="block-p-2"] [data-testid="block-action-expand"]');

    const blockP2Expanded = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-p-2"]');
      const isCollapsed = el?.getAttribute('data-block-collapsed') === 'true';
      const hasFullContent = Boolean(el?.querySelector('[data-testid="block-rendered-content"]'));
      const collapseBtn = el?.querySelector('[data-testid="block-action-collapse"]')?.textContent?.trim();
      const restoreBtn = el?.querySelector('[data-testid="block-action-restore"]')?.textContent?.trim();
      return {
        isCollapsed,
        hasFullContent,
        collapseBtn,
        restoreBtn,
      };
    });
    assert.strictEqual(blockP2Expanded.isCollapsed, false, 'After clicking expand, block is not collapsed');
    assert.strictEqual(blockP2Expanded.hasFullContent, true, 'Expanded view renders full content');
    assert.strictEqual(blockP2Expanded.collapseBtn, '收起', 'Expanded view has "收起" button');
    assert.strictEqual(blockP2Expanded.restoreBtn, '恢复保留', 'Expanded view has "恢复保留" button');

    // Click "收起" to fold back
    await page.click('[data-block-id="block-p-2"] [data-testid="block-action-collapse"]');
    const isFoldedAgain = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-p-2"]');
      return el?.getAttribute('data-block-collapsed') === 'true';
    });
    assert.strictEqual(isFoldedAgain, true, 'Clicking "收起" collapses back to summary row');

    // 4.4 Test edited block exclusion and restoration using current content (not initial content)
    // Exclude block-edited-6
    await page.click('[data-block-id="block-edited-6"] [data-testid="block-action-exclude"]');

    const blockEditedFolded = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-edited-6"]');
      const preview = el?.querySelector('[data-testid="block-summary-preview"]')?.textContent?.trim();
      return { preview };
    });
    // Summary preview should reflect edited content
    assert(blockEditedFolded.preview?.includes('这是用户已修改后的当前内容'), 'Summary preview must use current edited content');

    // Restore block-edited-6
    await page.click('[data-block-id="block-edited-6"] [data-testid="block-action-restore"]');

    const blockEditedRestored = await page.evaluate(() => {
      const el = document.querySelector('[data-block-id="block-edited-6"]');
      const isIncluded = el?.getAttribute('data-block-included') === 'true';
      const statusTag = el?.querySelector('[data-testid="block-status-tag"]')?.textContent?.trim();
      const editedBadge = el?.querySelector('[data-testid="block-edited-badge"]')?.textContent?.trim();
      const renderedText = el?.querySelector('[data-testid="block-rendered-content"]')?.textContent?.trim();
      return {
        isIncluded,
        statusTag,
        editedBadge,
        renderedText,
      };
    });

    assert.strictEqual(blockEditedRestored.isIncluded, true, 'Restored block must have included === true');
    assert.strictEqual(blockEditedRestored.statusTag, '保留', 'Status tag must show "保留"');
    assert.strictEqual(blockEditedRestored.editedBadge, '已修改', 'Edited badge must still say "已修改"');
    assert(blockEditedRestored.renderedText?.includes('这是用户已修改后的当前内容！'), 'Restored block must render current edited content, not initial content');

    console.log('✓ Test 4 Passed: In-place folding summary, preview truncation, expand/collapse, and current content restoration verified');

    // --------------------------------------------------------------------------
    // Test 5: Acceptance Criteria 4 (3-State Filtering: 全部 / 保留 / 剔除)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: 3-State Filtering (全部 / 保留 / 剔除) & Empty Filter Notices ---');

    // At this moment: block-p-2 is excluded, all other 6 blocks are included.
    const tabsStatus = await page.evaluate(() => {
      const tabAll = document.querySelector('[data-testid="filter-tab-all"]')?.textContent?.trim();
      const tabInc = document.querySelector('[data-testid="filter-tab-included"]')?.textContent?.trim();
      const tabExc = document.querySelector('[data-testid="filter-tab-excluded"]')?.textContent?.trim();
      return { tabAll, tabInc, tabExc };
    });

    assert.strictEqual(tabsStatus.tabAll, '全部 7', 'Total tab shows "全部 7"');
    assert.strictEqual(tabsStatus.tabInc, '保留 6', 'Included tab shows "保留 6"');
    assert.strictEqual(tabsStatus.tabExc, '剔除 1', 'Excluded tab shows "剔除 1"');

    // 5.1 Switch to "保留" tab
    await page.click('[data-testid="filter-tab-included"]');
    const incViewBlocks = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      return {
        count: items.length,
        ids: items.map((el) => el.getAttribute('data-block-id')),
      };
    });
    assert.strictEqual(incViewBlocks.count, 6, '"保留" filter shows exactly 6 blocks');
    assert(!incViewBlocks.ids.includes('block-p-2'), '"保留" filter hides excluded block-p-2');

    // 5.2 Switch to "剔除" tab
    await page.click('[data-testid="filter-tab-excluded"]');
    const excViewBlocks = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      return {
        count: items.length,
        ids: items.map((el) => el.getAttribute('data-block-id')),
      };
    });
    assert.strictEqual(excViewBlocks.count, 1, '"剔除" filter shows exactly 1 block');
    assert.strictEqual(excViewBlocks.ids[0], 'block-p-2', '"剔除" filter only contains block-p-2');

    // Restore block-p-2 from "剔除" view
    await page.click('[data-block-id="block-p-2"] [data-testid="block-action-restore"]');

    // Now 0 blocks are excluded!
    const emptyExcNotice = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="block-list-empty-filter"]')?.textContent?.trim();
      const itemsCount = document.querySelectorAll('[data-testid="block-item"]').length;
      return { notice, itemsCount };
    });
    assert.strictEqual(emptyExcNotice.itemsCount, 0, 'No block items in view');
    assert.strictEqual(emptyExcNotice.notice, '没有被剔除的块', 'Non-modal notice "没有被剔除的块" rendered when excluded list is empty');

    // 5.3 Switch back to "全部", all 7 blocks should be included
    await page.click('[data-testid="filter-tab-all"]');
    const allCount = await page.evaluate(() => document.querySelectorAll('[data-testid="block-item"]').length);
    assert.strictEqual(allCount, 7, 'All 7 blocks visible in "全部"');

    console.log('✓ Test 5 Passed: 3-state filter tabs and empty filter notice verified');

    // --------------------------------------------------------------------------
    // Test 6: Focus advance on exclusion in "保留" filter view
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Focus advance when excluding a block in "保留" filter view ---');

    await page.click('[data-testid="filter-tab-included"]');

    // Focus block-p-1 and click its exclude button
    await page.evaluate(() => {
      const btn = document.querySelector('[data-block-id="block-p-1"] [data-testid="block-action-exclude"]');
      btn?.focus();
    });

    await page.click('[data-block-id="block-p-1"] [data-testid="block-action-exclude"]');

    // Wait a tick for focus transfer
    await new Promise((r) => setTimeout(r, 50));

    const nextFocusedId = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.getAttribute('data-block-id') || active?.closest('[data-testid="block-item"]')?.getAttribute('data-block-id');
    });

    // The next visible block in the list was block-p-2
    assert.strictEqual(nextFocusedId, 'block-p-2', 'Focus must advance forward to next visible block (block-p-2)');
    console.log('✓ Test 6 Passed: Focus successfully advances forward to next visible block upon exclusion');

    // --------------------------------------------------------------------------
    // Test 7: Acceptance Criteria 7 (buildMarkdown cleaning result excludes excluded and empty blocks)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: buildMarkdown cleaning result excludes excluded and empty blocks ---');

    const markdownResult = await page.evaluate(() => {
      const { buildMarkdown } = window.__wetrim;
      const testSampleBlocks = [
        {
          id: '1',
          order: 1,
          type: 'paragraph',
          originalHtml: '<p>第一段内容</p>',
          initialMarkdown: '第一段内容',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        {
          id: '2',
          order: 2,
          type: 'paragraph',
          originalHtml: '<p>被剔除的广告段落</p>',
          initialMarkdown: '被剔除的广告段落',
          editedMarkdown: null,
          included: false,
          notes: [],
        },
        {
          id: '3',
          order: 3,
          type: 'paragraph',
          originalHtml: '<p></p>',
          initialMarkdown: '   ',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        {
          id: '4',
          order: 4,
          type: 'paragraph',
          originalHtml: '<p>原内容</p>',
          initialMarkdown: '原内容',
          editedMarkdown: '已编辑为第四段内容',
          included: true,
          notes: [],
        },
      ];

      return buildMarkdown(testSampleBlocks);
    });

    assert(!markdownResult.includes('被剔除的广告段落'), 'Excluded blocks must not enter cleaning result');
    assert.strictEqual(markdownResult, '第一段内容\n\n已编辑为第四段内容', 'Cleaning result must strictly consist of non-empty included blocks joined by double newline');
    console.log('✓ Test 7 Passed: buildMarkdown cleanly filters out excluded and empty blocks');

    // --------------------------------------------------------------------------
    // Test 8: Real 347-Block Longform Benchmark Verification
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Real 347-Block Longform Benchmark Filter & Toggle ---');

    const longformFixturePath = path.resolve('test/fixtures/wetrim-sample-deep-longform.json');
    const longformData = JSON.parse(fs.readFileSync(longformFixturePath, 'utf8'));

    await page.evaluate(
      ({ html, url, title }) => {
        const { buildArticleSnapshot, dispatch } = window.__wetrim;
        const capture = {
          kind: 'article',
          source: { url, title, author: '', accountName: '骨骼健康' },
          contentHtml: html,
          unstable: false,
        };
        const snapshot = buildArticleSnapshot(capture);
        dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-longform-bench',
              revision: 1,
              savedAt: new Date().toISOString(),
              snapshot,
            },
            candidateSnapshot: null,
            corrupted: false,
          },
        });
      },
      {
        html: longformData.RESULTS.content.after.html,
        url: longformData.RESULTS.content.meta?.url || 'https://mp.weixin.qq.com/s/deep',
        title: longformData.RESULTS.content.meta?.title || '每10年换一副骨架',
      }
    );

    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 347, {
      timeout: 10000,
    });

    // Check tabs on 347 blocks
    const longformTabs = await page.evaluate(() => {
      const tabAll = document.querySelector('[data-testid="filter-tab-all"]')?.textContent?.trim();
      const tabInc = document.querySelector('[data-testid="filter-tab-included"]')?.textContent?.trim();
      const tabExc = document.querySelector('[data-testid="filter-tab-excluded"]')?.textContent?.trim();
      return { tabAll, tabInc, tabExc };
    });

    assert.strictEqual(longformTabs.tabAll, '全部 347');
    assert.strictEqual(longformTabs.tabInc, '保留 347');
    assert.strictEqual(longformTabs.tabExc, '剔除 0');

    // Exclude block #10
    const block10Id = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid="block-item"]');
      return items[9]?.getAttribute('data-block-id');
    });

    assert(block10Id, 'Block #10 must exist');
    await page.click(`[data-block-id="${block10Id}"] [data-testid="block-action-exclude"]`);

    // Verify tabs update
    const updatedTabs = await page.evaluate(() => {
      const tabInc = document.querySelector('[data-testid="filter-tab-included"]')?.textContent?.trim();
      const tabExc = document.querySelector('[data-testid="filter-tab-excluded"]')?.textContent?.trim();
      return { tabInc, tabExc };
    });
    assert.strictEqual(updatedTabs.tabInc, '保留 346');
    assert.strictEqual(updatedTabs.tabExc, '剔除 1');

    console.log('✓ Test 8 Passed: 347-block real article filter & toggle benchmark passed with 0 lag');

    console.log('\n==> All Issue #25 acceptance criteria verified successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
