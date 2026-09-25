import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #29 Verification (Search, Order Navigation & Sticky Workbench Header)...');

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
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Setup test article session with known content blocks
    // --------------------------------------------------------------------------
    const testBlocks = [
      {
        id: 'block-1',
        order: 1,
        type: 'heading',
        headingLevel: 1,
        originalHtml: '<h1>骨骼健康的科学基础</h1>',
        initialMarkdown: '# 骨骼健康的科学基础',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-2',
        order: 2,
        type: 'paragraph',
        originalHtml: '<p>人体骨骼每隔大约十年就会通过代谢完整更新一次。链接：<a href="https://example.com/bone-health-secret">参考来源</a></p>',
        initialMarkdown: '人体骨骼每隔大约十年就会通过代谢完整更新一次。链接：[参考来源](https://example.com/bone-health-secret)',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-3',
        order: 3,
        type: 'paragraph',
        originalHtml: '<p>成骨细胞与破骨细胞保持平衡是骨骼强健的关键。注意：这是待剔除的段落。</p>',
        initialMarkdown: '成骨细胞与破骨细胞保持平衡是骨骼强健的关键。注意：这是待剔除的段落。',
        editedMarkdown: null,
        included: false, // 初始剔除并折叠
        notes: [],
      },
      {
        id: 'block-4',
        order: 4,
        type: 'paragraph',
        originalHtml: '<p>日常运动能够刺激成骨细胞活性，促进骨骼对钙质的吸收与沉积。含有图片：<img src="https://example.com/img-secret-bone.jpg" alt="骨骼结构图" /></p>',
        initialMarkdown: '日常运动能够刺激成骨细胞活性，促进骨骼对钙质的吸收与沉积。含有图片：![骨骼结构图](https://example.com/img-secret-bone.jpg)',
        editedMarkdown: null,
        included: true,
        notes: [],
      },
      {
        id: 'block-5',
        order: 5,
        type: 'paragraph',
        originalHtml: '<p>最后一节是总结骨骼护理的要点。</p>',
        initialMarkdown: '最后一节是总结骨骼护理的要点。',
        editedMarkdown: '最后一节是总结骨骼护理的要点（这是用户编辑后的当前内容，特别提到了骨骼韧性）。',
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
            sessionId: 'sess-issue29-test',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              articleId: 'art-29',
              capturedAt: new Date().toISOString(),
              source: {
                url: 'https://mp.weixin.qq.com/s/issue29',
                title: '骨骼健康指南与科学清洗',
                account: '骨骼科普',
                publishedAt: '2026-09-25',
              },
              blocks,
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, testBlocks);

    await page.waitForSelector('[data-testid="block-items-stream"]');

    // --------------------------------------------------------------------------
    // Test 2: Sticky Header & Toolbar Layout
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Sticky Header & Toolbar Layout in Cleaning Mode ---');
    const headerInfo = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="workbench-header"]');
      const toolbar = document.querySelector('[data-testid="header-nav-toolbar"]');
      const searchBox = document.querySelector('[data-testid="search-box"]');
      const orderBox = document.querySelector('[data-testid="order-jump-box"]');
      const filterTabs = document.querySelector('[data-testid="filter-tabs"]');
      const actionReturn = document.querySelector('[data-testid="action-return"]');

      return {
        isSticky: header?.classList.contains('is-sticky'),
        hasToolbar: !!toolbar,
        hasSearchBox: !!searchBox,
        hasOrderBox: !!orderBox,
        hasFilterTabs: !!filterTabs,
        hasActionReturn: !!actionReturn,
      };
    });

    assert.strictEqual(headerInfo.isSticky, true, 'Header has is-sticky class in cleaning mode');
    assert.strictEqual(headerInfo.hasToolbar, true, 'Toolbar rendered in cleaning mode');
    assert.strictEqual(headerInfo.hasSearchBox, true, 'Search box rendered');
    assert.strictEqual(headerInfo.hasOrderBox, true, 'Order jump box rendered');
    assert.strictEqual(headerInfo.hasFilterTabs, true, 'Filter tabs rendered in header');
    assert.strictEqual(headerInfo.hasActionReturn, true, 'Return to original button rendered in header');
    console.log('✓ Test 2 Passed: Sticky Header and all toolbar controls rendered correctly');

    // --------------------------------------------------------------------------
    // Test 3: Search matching rules (visible text, case-insensitive, URLs excluded)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Search matching rules (visible text, URLs excluded) ---');

    // 3.1 Search for Markdown URL which should NOT match
    await page.type('[data-testid="search-input"]', 'bone-health-secret');
    let searchResult = await page.evaluate(() => {
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      const notFound = document.querySelector('[data-testid="search-not-found"]')?.textContent?.trim();
      return { counter, notFound };
    });
    assert.strictEqual(searchResult.notFound, '没有找到「bone-health-secret」', 'Markdown link URL must not match');

    // Clear search
    await page.click('[data-testid="search-clear-btn"]');

    // 3.2 Search for image URL which should NOT match
    await page.type('[data-testid="search-input"]', 'img-secret-bone');
    searchResult = await page.evaluate(() => {
      return document.querySelector('[data-testid="search-not-found"]')?.textContent?.trim();
    });
    assert.strictEqual(searchResult, '没有找到「img-secret-bone」', 'Image src URL must not match');

    await page.click('[data-testid="search-clear-btn"]');

    // 3.3 Search for visible text "骨骼" in "全部" filter
    await page.type('[data-testid="search-input"]', '骨骼');
    searchResult = await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      const ariaLive = document.querySelector('[data-testid="search-counter"]')?.getAttribute('aria-label');
      const state = blockListRef.current?.getSearchState();
      return { counter, ariaLive, state };
    });

    // In block 1: "骨骼" (1)
    // In block 2: "骨骼" (1)
    // In block 3: "骨骼" (1, but block 3 is excluded!)
    // In block 4: "骨骼" (1 in text + 1 in alt "骨骼结构图" = wait, img alt or text: text has "骨骼")
    // In block 5: "骨骼" (2 in edited text: "骨骼护理", "骨骼韧性")
    // Under 'all' filter: all blocks are visible!
    assert(searchResult.state.totalHits >= 5, 'Total hits should be at least 5');
    assert.strictEqual(searchResult.counter, `1 / ${searchResult.state.totalHits}`);
    assert.strictEqual(searchResult.ariaLive, `第 1 处，共 ${searchResult.state.totalHits} 处`);
    console.log(`✓ Test 3 Passed: Search matches visible text (${searchResult.state.totalHits} hits), URLs excluded, aria-live accurate`);

    // --------------------------------------------------------------------------
    // Test 4: CSS Custom Highlight API & Left-Edge Proof Notches
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: CSS Custom Highlight API & Left-Edge Proof Notches ---');
    const highlightsAndNotches = await page.evaluate(() => {
      const hasCSSHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;
      const hitHighlight = CSS.highlights.get('search-hit');
      const curHighlight = CSS.highlights.get('search-hit-current');

      const itemsWithNotch = document.querySelectorAll('[data-testid="block-item"][data-has-hit="true"]');
      const currentItemWithNotch = document.querySelectorAll('[data-testid="block-item"][data-is-current-hit="true"]');

      return {
        hasCSSHighlights,
        hitRangeCount: hitHighlight ? hitHighlight.size : 0,
        curRangeCount: curHighlight ? curHighlight.size : 0,
        notchCount: itemsWithNotch.length,
        currentNotchCount: currentItemWithNotch.length,
        currentBlockId: currentItemWithNotch[0]?.getAttribute('data-block-id'),
      };
    });

    assert.strictEqual(highlightsAndNotches.hasCSSHighlights, true, 'CSS.highlights is supported');
    assert.strictEqual(highlightsAndNotches.curRangeCount, 1, 'Current hit has 1 range in search-hit-current');
    assert(highlightsAndNotches.hitRangeCount >= 4, 'Other hits have ranges in search-hit');
    assert(highlightsAndNotches.notchCount >= 4, 'Blocks with hits have data-has-hit="true" notch');
    assert.strictEqual(highlightsAndNotches.currentNotchCount, 1, 'Exactly 1 block has data-is-current-hit="true"');
    assert.strictEqual(highlightsAndNotches.currentBlockId, 'block-1', 'First hit is in block-1');
    console.log('✓ Test 4 Passed: CSS Custom Highlight API registered and left-edge notches active');

    // --------------------------------------------------------------------------
    // Test 5: Next / Prev Hit Navigation & Wrap-around Notice
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Next / Prev Navigation & Wrap-around Notice ---');

    // Navigate to next hit (hit 2)
    await page.click('[data-testid="search-next-btn"]');
    let navHit = await page.evaluate(() => {
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      const currentBlockId = document.querySelector('[data-testid="block-item"][data-is-current-hit="true"]')?.getAttribute('data-block-id');
      return { counter, currentBlockId };
    });
    assert.strictEqual(navHit.counter.startsWith('2 /'), true, 'Advanced to hit 2');
    assert.strictEqual(navHit.currentBlockId, 'block-2', 'Current block is now block-2');

    // Navigate to previous hit (back to hit 1)
    await page.click('[data-testid="search-prev-btn"]');
    navHit = await page.evaluate(() => {
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      return counter;
    });
    assert.strictEqual(navHit.startsWith('1 /'), true, 'Returned to hit 1');

    // Wrap around backwards: from hit 1 to last hit
    await page.click('[data-testid="search-prev-btn"]');
    navHit = await page.evaluate(() => {
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      const { blockListRef } = window.__wetrim;
      const state = blockListRef.current?.getSearchState();
      return { counter, state };
    });
    assert.strictEqual(navHit.counter, `${navHit.state.totalHits} / ${navHit.state.totalHits}`);

    // Wrap around forwards: from last hit to hit 1 (shows "已回到第一处")
    await page.click('[data-testid="search-next-btn"]');
    const wrapNotice = await page.evaluate(() => {
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      const toast = document.querySelector('[data-testid="search-wrapped-tip"]')?.textContent?.trim();
      return { counter, toast };
    });
    assert.strictEqual(wrapNotice.counter.startsWith('1 /'), true, 'Wrapped to hit 1');
    assert.strictEqual(wrapNotice.toast, '已回到第一处', 'Wrap-around toast "已回到第一处" displayed');
    console.log('✓ Test 5 Passed: Next/Prev navigation and wrap-around toast verified');

    // --------------------------------------------------------------------------
    // Test 6: Search Hit in Folded Excluded Block (Temp Expand & Collapse)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Folded Excluded Block Temp Expand & Collapse ---');

    // Block 3 is excluded and initially collapsed
    const b3InitialState = await page.evaluate(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return {
        collapsed: b3?.getAttribute('data-block-collapsed'),
        hasRenderedContent: !!b3?.querySelector('.block-rendered-content'),
      };
    });
    assert.strictEqual(b3InitialState.collapsed, 'true', 'Block 3 is initially collapsed');
    assert.strictEqual(b3InitialState.hasRenderedContent, false, 'Collapsed block has no rendered content');

    // Jump to hit in block 3 (hit #3 in document order)
    await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      blockListRef.current?.gotoHit(2); // 0-indexed: hit 2 is in block-3
    });

    await page.waitForFunction(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return b3?.getAttribute('data-block-collapsed') === 'false';
    }, { timeout: 3000 });

    const b3TempExpanded = await page.evaluate(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      const isCurHit = b3?.getAttribute('data-is-current-hit');
      return {
        collapsed: b3?.getAttribute('data-block-collapsed'),
        hasRenderedContent: !!b3?.querySelector('.block-rendered-content'),
        isCurHit,
      };
    });
    assert.strictEqual(b3TempExpanded.collapsed, 'false', 'Block 3 is temporarily expanded');
    assert.strictEqual(b3TempExpanded.hasRenderedContent, true, 'Rendered content mounted for highlighting');
    assert.strictEqual(b3TempExpanded.isCurHit, 'true', 'Block 3 marked as current hit');

    // Leave block 3 by navigating to hit 4 (in block-4)
    await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      blockListRef.current?.gotoHit(3);
    });

    await page.waitForFunction(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return b3?.getAttribute('data-block-collapsed') === 'true';
    }, { timeout: 3000 });

    const b3CollapsedAgain = await page.evaluate(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return b3?.getAttribute('data-block-collapsed');
    });
    assert.strictEqual(b3CollapsedAgain, 'true', 'Block 3 automatically collapses back upon leaving');

    // Test 6.2: Consecutive hits inside the same folded excluded block maintain temp expansion
    await page.evaluate(() => {
      const { dispatch, blockListRef } = window.__wetrim;
      dispatch({
        type: 'UPDATE_BLOCK',
        payload: {
          blockId: 'block-3',
          editedMarkdown: '成骨细胞是骨骼强健的关键，骨骼代谢需要充足营养。',
        },
      });
      blockListRef.current?.search('骨骼');
      blockListRef.current?.gotoHit(2); // Jump to first hit in block 3
    });

    await page.waitForFunction(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return b3?.getAttribute('data-block-collapsed') === 'false';
    }, { timeout: 3000 });

    // Advance to next hit (hit 3 is also in block 3)
    await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      blockListRef.current?.gotoHit(3);
    });

    const b3StillExpanded = await page.evaluate(() => {
      const b3 = document.querySelector('[data-block-id="block-3"]');
      return b3?.getAttribute('data-block-collapsed');
    });
    assert.strictEqual(b3StillExpanded, 'false', 'Block 3 remains expanded across consecutive hits within same block');

    // Restore block 3 to original state for subsequent tests
    await page.evaluate(() => {
      const { dispatch, blockListRef } = window.__wetrim;
      dispatch({
        type: 'UPDATE_BLOCK',
        payload: {
          blockId: 'block-3',
          editedMarkdown: null,
        },
      });
      blockListRef.current?.search('骨骼');
      blockListRef.current?.gotoHit(0);
    });

    console.log('✓ Test 6 Passed: Excluded folded block temporarily expands when jumped to, remains expanded for consecutive hits, and collapses upon leaving');

    // --------------------------------------------------------------------------
    // Test 7: Search Hit in Editing Block (Textarea Selection)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Search Hit in Editing Block (Textarea Selection) ---');

    // Enter edit mode on block 5
    await page.click('[data-block-id="block-5"] [data-testid="block-action-edit"]');
    await page.waitForSelector('[data-block-id="block-5"] [data-testid="block-editor-textarea"]');

    // Jump to hit in block 5 (last hit)
    await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      const state = blockListRef.current?.getSearchState();
      blockListRef.current?.gotoHit(state.totalHits - 1);
    });

    // Verify textarea selection
    const textareaSelection = await page.evaluate(() => {
      const ta = document.querySelector('[data-block-id="block-5"] [data-testid="block-editor-textarea"]');
      if (!ta) return null;
      const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      return {
        selected,
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
      };
    });

    assert.strictEqual(textareaSelection?.selected, '骨骼', 'Textarea selected text matches search query');

    // Finish editing
    await page.click('[data-block-id="block-5"] [data-testid="block-action-finish-edit"]');
    await page.waitForSelector('[data-block-id="block-5"] .block-rendered-content');
    console.log('✓ Test 7 Passed: Search hit in editing block accurately focuses and selects textarea range');

    // --------------------------------------------------------------------------
    // Test 8: Filter combination with search ("另有 N 处在已剔除块中" & One-Click Switch)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Search & Filter Combination ---');

    // Switch to "保留" tab
    await page.click('[data-testid="filter-tab-included"]');

    // Under "保留", block 3 is excluded and hidden.
    const filteredSearchState = await page.evaluate(() => {
      const hiddenNotice = document.querySelector('[data-testid="search-hidden-notice"]')?.textContent?.trim();
      const switchBtn = document.querySelector('[data-testid="search-switch-to-all"]')?.textContent?.trim();
      const { blockListRef } = window.__wetrim;
      const state = blockListRef.current?.getSearchState();
      return { hiddenNotice, switchBtn, state };
    });

    assert.strictEqual(filteredSearchState.state.hiddenHitsCount, 1, '1 hit in hidden excluded block');
    assert(filteredSearchState.hiddenNotice?.includes('另有 1 处在已剔除块中'), 'Hidden hits notice rendered');
    assert.strictEqual(filteredSearchState.switchBtn, '切到「全部」', 'One-click switch button rendered');

    // Click "切到「全部」"
    await page.click('[data-testid="search-switch-to-all"]');

    const switchedBackState = await page.evaluate(() => {
      const activeTab = document.querySelector('[data-testid="filter-tabs"] .is-active')?.getAttribute('data-filter');
      const hiddenNotice = document.querySelector('[data-testid="search-hidden-notice"]');
      const { blockListRef } = window.__wetrim;
      const state = blockListRef.current?.getSearchState();
      return { activeTab, hasHiddenNotice: !!hiddenNotice, totalHits: state.totalHits };
    });

    assert.strictEqual(switchedBackState.activeTab, 'all', 'Filter automatically switched to "全部"');
    assert.strictEqual(switchedBackState.hasHiddenNotice, false, 'Hidden notice dismissed');
    console.log('✓ Test 8 Passed: Search and filter combination with "另有 N 处在已剔除块中" and one-click switch verified');

    // --------------------------------------------------------------------------
    // Test 9: Order Locating (# jump, out-of-range, hidden block notice)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Order Locating ---');

    // 9.1 Valid jump: jump to #4
    await page.click('[data-testid="order-jump-input"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('[data-testid="order-jump-input"]', '4');
    await page.click('[data-testid="order-jump-btn"]');

    const jump4Target = await page.evaluate(() => {
      return document.activeElement?.getAttribute('data-block-id');
    });
    assert.strictEqual(jump4Target, 'block-4', 'Jumped to and focused block #4');

    // 9.2 Out-of-range jump: jump to #99
    await page.click('[data-testid="order-jump-input"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('[data-testid="order-jump-input"]', '99');
    await page.click('[data-testid="order-jump-btn"]');

    const outOfRangeTip = await page.evaluate(() => {
      return document.querySelector('[data-testid="order-jump-tip"]')?.textContent?.trim();
    });
    assert.strictEqual(outOfRangeTip, '共 5 块', 'Out of range correctly tips "共 5 块"');

    // 9.3 Hidden block jump: under "保留" filter, try to jump to #3 (which is excluded)
    await page.click('[data-testid="filter-tab-included"]');
    await page.click('[data-testid="order-jump-input"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('[data-testid="order-jump-input"]', '3');
    await page.click('[data-testid="order-jump-btn"]');

    const hiddenJumpTip = await page.evaluate(() => {
      const tipText = document.querySelector('[data-testid="order-jump-tip"] .order-jump-tip-text')?.textContent?.trim();
      const switchBtn = document.querySelector('[data-testid="order-jump-switch-all"]')?.textContent?.trim();
      return { tipText, switchBtn };
    });

    assert.strictEqual(hiddenJumpTip.tipText, '第 3 块已被剔除，当前筛选下看不到', 'Hidden block notice accurately explains block 3 is excluded');
    assert.strictEqual(hiddenJumpTip.switchBtn, '切到「全部」并跳过去', 'Provides "切到「全部」并跳过去" button');

    // Click "切到「全部」并跳过去"
    await page.click('[data-testid="order-jump-switch-all"]');

    await page.waitForFunction(() => document.activeElement?.getAttribute('data-block-id') === 'block-3', {
      timeout: 3000,
    });

    const switchedAndJumped = await page.evaluate(() => {
      const activeTab = document.querySelector('[data-testid="filter-tabs"] .is-active')?.getAttribute('data-filter');
      const focusedBlockId = document.activeElement?.getAttribute('data-block-id');
      const hasTip = !!document.querySelector('[data-testid="order-jump-tip"]');
      return { activeTab, focusedBlockId, hasTip };
    });

    assert.strictEqual(switchedAndJumped.activeTab, 'all', 'Switched to "全部" filter');
    assert.strictEqual(switchedAndJumped.focusedBlockId, 'block-3', 'Focused target block 3');
    assert.strictEqual(switchedAndJumped.hasTip, false, 'Tip dismissed after jump');
    console.log('✓ Test 9 Passed: Order locating (valid, out of range, hidden block notice & switch-and-jump) verified');

    // --------------------------------------------------------------------------
    // Test 10: Keyboard Shortcuts (Ctrl/Cmd+F, Esc, Enter)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: Keyboard Shortcuts ---');

    // Clear search first
    await page.click('[data-testid="search-clear-btn"]');

    // Focus away from search input
    await page.click('[data-block-id="block-1"]');

    // Press Ctrl+F
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');

    const isSearchFocused = await page.evaluate(() => {
      return document.activeElement?.getAttribute('data-testid') === 'search-input';
    });
    assert.strictEqual(isSearchFocused, true, 'Ctrl+F focuses search input');

    // Type query "骨骼"
    await page.type('[data-testid="search-input"]', '骨骼');

    // Press Enter to go to next hit
    await page.keyboard.press('Enter');
    let hitCounter = await page.evaluate(() => document.querySelector('[data-testid="search-counter"]')?.textContent?.trim());
    assert.strictEqual(hitCounter?.startsWith('2 /'), true, 'Enter advances to next hit');

    // Press Shift+Enter to go to prev hit
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    hitCounter = await page.evaluate(() => document.querySelector('[data-testid="search-counter"]')?.textContent?.trim());
    assert.strictEqual(hitCounter?.startsWith('1 /'), true, 'Shift+Enter moves to previous hit');

    // Press Escape to return focus to current hit block
    await page.keyboard.press('Escape');
    const focusAfterEsc = await page.evaluate(() => {
      const activeEl = document.activeElement;
      const counter = document.querySelector('[data-testid="search-counter"]')?.textContent?.trim();
      return {
        focusedId: activeEl?.getAttribute('data-block-id'),
        hasCounter: !!counter,
      };
    });
    assert.strictEqual(focusAfterEsc.focusedId, 'block-1', 'Esc returns focus to hit block 1');
    assert.strictEqual(focusAfterEsc.hasCounter, true, 'Search query and highlights preserved after Esc');
    console.log('✓ Test 10 Passed: Keyboard shortcuts (Ctrl+F, Enter, Shift+Enter, Esc) verified');

    // --------------------------------------------------------------------------
    // Test 11: Read-only Mode Hides Toolbar
    // --------------------------------------------------------------------------
    console.log('\n--- Test 11: Read-only Mode Hides Toolbar ---');
    await page.evaluate(() => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-issue29-ro',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              articleId: 'art-ro',
              capturedAt: new Date().toISOString(),
              source: { url: 'https://mp.weixin.qq.com/s/ro', title: '只读文章' },
              blocks: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: true,
        },
      });
    });

    await page.waitForFunction(() => {
      return document.querySelector('[data-testid="read-only-note"]') !== null;
    });

    const roToolbar = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-testid="header-nav-toolbar"]');
      const roNote = document.querySelector('[data-testid="read-only-note"]');
      return { hasToolbar: !!toolbar, hasRoNote: !!roNote };
    });
    assert.strictEqual(roToolbar.hasToolbar, false, 'Toolbar is completely hidden in read-only mode');
    assert.strictEqual(roToolbar.hasRoNote, true, 'Read-only note is displayed');
    console.log('✓ Test 11 Passed: Read-only mode hides toolbar per spec');

    // --------------------------------------------------------------------------
    // Test 12: 4× CPU Slowdown Performance Benchmarks (347-Block Real & 600-Block Synthetic)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 12: 4× CPU Slowdown Performance Benchmarks (Real 347 Blocks & Synthetic 600 Blocks) ---');

    const client = await page.createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    console.log('==> CPU throttling set to 4× slowdown');

    // 12.1 Real 347-Block Deep Longform Benchmark
    const longformFixturePath = path.resolve('test/fixtures/wetrim-sample-deep-longform.json');
    assert(fs.existsSync(longformFixturePath), '347-block fixture must exist');
    const longformData = JSON.parse(fs.readFileSync(longformFixturePath, 'utf8'));

    await page.evaluate(
      ({ html, url, title }) => {
        const { buildArticleSnapshot, dispatch } = window.__wetrim;
        const snapshot = buildArticleSnapshot({
          kind: 'article',
          source: { url, title, author: '', accountName: '骨骼健康' },
          contentHtml: html,
          unstable: false,
        });

        dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: 'sess-perf-347',
              revision: 1,
              savedAt: new Date().toISOString(),
              snapshot,
            },
            candidateSnapshot: null,
            corrupted: false,
            isReadOnly: false,
          },
        });
      },
      {
        html: longformData.RESULTS.content.after.html,
        url: longformData.sourceUrl,
        title: longformData.title,
      }
    );

    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 347, {
      timeout: 15000,
    });

    // 12.1.a Measure Search Input to Hit Count & Highlighting on 347 blocks @4×
    const realSearchPerf = await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      const t0 = performance.now();
      const state = blockListRef.current.search('骨骼');
      const t1 = performance.now();
      return { latency: t1 - t0, totalHits: state.totalHits };
    });

    console.log(`[Perf @4× Real 347 Blocks] Search latency: ${realSearchPerf.latency.toFixed(2)} ms (hits: ${realSearchPerf.totalHits}, budget ≤ 100 ms)`);
    assert(realSearchPerf.latency <= 100, `Real 347 blocks search latency ${realSearchPerf.latency} ms must be ≤ 100 ms`);

    // 12.1.b Measure Filter Switch on 347 blocks @4×
    const realFilterPerf = await page.evaluate(async () => {
      const { blockListRef } = window.__wetrim;
      const t0 = performance.now();
      blockListRef.current.setFilter('included');
      await new Promise((r) => requestAnimationFrame(r));
      const t1 = performance.now();
      return { latency: t1 - t0 };
    });

    console.log(`[Perf @4× Real 347 Blocks] Filter switch latency: ${realFilterPerf.latency.toFixed(2)} ms (budget ≤ 100 ms)`);
    assert(realFilterPerf.latency <= 100, `Real 347 blocks filter switch latency ${realFilterPerf.latency} ms must be ≤ 100 ms`);

    // 12.2 Synthetic 600-Block Benchmark
    const synthetic600Blocks = [];
    for (let i = 1; i <= 600; i++) {
      const isWord = i % 5 === 0;
      synthetic600Blocks.push({
        id: `synth-block-${i}`,
        order: i,
        type: i % 10 === 1 ? 'heading' : 'paragraph',
        headingLevel: i % 10 === 1 ? 2 : undefined,
        originalHtml: `<p>第 ${i} 块内容：${isWord ? '骨骼代谢与骨质重建机制' : '这是用于验证大规模长文连续渲染的合成段落文字'}。</p>`,
        initialMarkdown: `第 ${i} 块内容：${isWord ? '骨骼代谢与骨质重建机制' : '这是用于验证大规模长文连续渲染的合成段落文字'}。`,
        editedMarkdown: null,
        included: i % 7 !== 0,
        notes: [],
      });
    }

    await page.evaluate((blocks) => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-synth-600',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              articleId: 'art-synth-600',
              capturedAt: new Date().toISOString(),
              source: { url: 'https://example.com/synth-600', title: '600块合成性能基准长文' },
              blocks,
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, synthetic600Blocks);

    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length > 500, {
      timeout: 15000,
    });

    // 12.2.a Measure Search Input to Hit Count & Highlighting on 600 blocks @4×
    const synthSearchPerf = await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      const t0 = performance.now();
      const state = blockListRef.current.search('骨骼');
      const t1 = performance.now();
      return { latency: t1 - t0, totalHits: state.totalHits };
    });

    console.log(`[Perf @4× Synthetic 600 Blocks] Search latency: ${synthSearchPerf.latency.toFixed(2)} ms (hits: ${synthSearchPerf.totalHits}, budget ≤ 100 ms)`);
    assert(synthSearchPerf.latency <= 100, `Synthetic 600 blocks search latency ${synthSearchPerf.latency} ms must be ≤ 100 ms`);

    // 12.2.b Measure Filter Switch on 600 blocks @4×
    const synthFilterPerf = await page.evaluate(async () => {
      const { blockListRef } = window.__wetrim;
      const t0 = performance.now();
      blockListRef.current.setFilter('included');
      await new Promise((r) => requestAnimationFrame(r));
      const t1 = performance.now();
      return { latency: t1 - t0 };
    });

    console.log(`[Perf @4× Synthetic 600 Blocks] Filter switch latency: ${synthFilterPerf.latency.toFixed(2)} ms (budget ≤ 100 ms)`);
    assert(synthFilterPerf.latency <= 100, `Synthetic 600 blocks filter switch latency ${synthFilterPerf.latency} ms must be ≤ 100 ms`);

    // Reset CPU throttling
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log('✓ Test 12 Passed: All 4× CPU slowdown performance targets ≤ 100 ms met for both 347 real and 600 synthetic blocks');

    console.log('\n=============================================');
    console.log('✓ All Issue #29 acceptance criteria verified successfully!');
    console.log('=============================================');
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Issue #29 Verification Failed:', err);
  process.exit(1);
});
