import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #31 Verification (Inspection & Result Summary Preview)...');

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

    // Clean storage
    await worker.evaluate(() => chrome.storage.local.clear());

    page = await browser.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (!text.includes('[WeTrim Self-Test]')) {
        console.log('[Browser Console]', text);
      }
    });
    page.on('pageerror', (err) => console.log('[Browser Page Error]', err));

    await page.setViewport({ width: 1200, height: 800 });
    const appUrl = `chrome-extension://${extId}/app.html`;
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 2: Pure Dialect & Serialization Tests (buildResultFile, buildFrontMatter, stripBoundaryEmptyLines, buildMarkdown)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Pure Dialect & Serialization Tests ---');

    const dialectTestsPassed = await page.evaluate(() => {
      const {
        stripBoundaryEmptyLines,
        buildMarkdown,
        buildFrontMatter,
        buildResultFile,
      } = window.__wetrim;

      // 2.1 stripBoundaryEmptyLines: 保留内部缩进与空行，仅去掉块首尾空行
      const codeBlockText = '\n\n    def calculate_score(val):\n        return val * 10\n\n';
      const strippedCode = stripBoundaryEmptyLines(codeBlockText);
      if (strippedCode !== '    def calculate_score(val):\n        return val * 10') {
        throw new Error(`stripBoundaryEmptyLines failed on indented code: got "${strippedCode}"`);
      }

      // 保留末尾两个空格的硬换行
      const hardBreakText = '第一行文字  \n第二行文字\n\n';
      const strippedHardBreak = stripBoundaryEmptyLines(hardBreakText);
      if (strippedHardBreak !== '第一行文字  \n第二行文字') {
        throw new Error(`stripBoundaryEmptyLines failed on hard break: got "${strippedHardBreak}"`);
      }

      // 2.2 buildMarkdown: 过滤剔除块、空白块，保留内部缩进
      const sampleBlocks = [
        {
          id: 'b1',
          order: 1,
          type: 'paragraph',
          originalHtml: '<p>前言段落</p>',
          initialMarkdown: '前言段落',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        {
          id: 'b2',
          order: 2,
          type: 'code',
          originalHtml: '<pre><code>    var x = 1;\n    var y = 2;</code></pre>',
          initialMarkdown: '    var x = 1;\n    var y = 2;',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        {
          id: 'b3',
          order: 3,
          type: 'paragraph',
          originalHtml: '<p>剔除段落</p>',
          initialMarkdown: '剔除段落',
          editedMarkdown: null,
          included: false,
          notes: [],
        },
        {
          id: 'b4',
          order: 4,
          type: 'paragraph',
          originalHtml: '<p>空白段落</p>',
          initialMarkdown: '   \n  \t ',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
      ];

      const mdOut = buildMarkdown(sampleBlocks);
      const expectedMd = '前言段落\n\n    var x = 1;\n    var y = 2;';
      if (mdOut !== expectedMd) {
        throw new Error(`buildMarkdown output mismatch: got "${mdOut}"`);
      }

      // 2.3 buildFrontMatter: 固定四字段、转义、省略未知值、UTC+8日期
      const fullSource = {
        title: '谈谈"架构"与：规范',
        account: '印厂技术谈',
        publishedAt: '2026-09-01',
        url: 'https://mp.weixin.qq.com/s/sample_1',
      };
      const fmFull = buildFrontMatter(fullSource);
      if (!fmFull.includes('title: "谈谈\\"架构\\"与：规范"')) {
        throw new Error(`FrontMatter title escaping failed: "${fmFull}"`);
      }
      if (!fmFull.includes('account: 印厂技术谈')) {
        throw new Error(`FrontMatter account missing: "${fmFull}"`);
      }
      if (!fmFull.includes('date: 2026-09-01')) {
        throw new Error(`FrontMatter date missing: "${fmFull}"`);
      }
      if (!fmFull.includes('source: "https://mp.weixin.qq.com/s/sample_1"')) {
        throw new Error(`FrontMatter source escaping missing: "${fmFull}"`);
      }

      // 省略未知值与解析失败的日期
      const partialSource = {
        title: '仅有标题与非法日期',
        account: null,
        publishedAt: 'invalid-date',
        url: '',
      };
      const fmPartial = buildFrontMatter(partialSource);
      if (fmPartial.includes('account') || fmPartial.includes('date') || fmPartial.includes('source')) {
        throw new Error(`FrontMatter did not omit unknown/invalid fields: "${fmPartial}"`);
      }
      if (!fmPartial.includes('title: 仅有标题与非法日期')) {
        throw new Error(`FrontMatter partial title missing: "${fmPartial}"`);
      }

      // 裸写会被 YAML 解析成数字/布尔/日期/null 的值必须加引号
      for (const [title, expected] of [
        ['2024', 'title: "2024"'],
        ['true', 'title: "true"'],
        ['null', 'title: "null"'],
        ['2026-09-01', 'title: "2026-09-01"'],
        ['2024年总结', 'title: 2024年总结'],
      ]) {
        const fm = buildFrontMatter({ title, account: null, publishedAt: null, url: '' });
        if (!fm.includes(expected)) {
          throw new Error(`FrontMatter non-string scalar quoting failed for "${title}": "${fm}"`);
        }
      }

      // 全部字段为空时返回空字符串
      const emptySource = { title: '', account: null, publishedAt: null, url: '' };
      const fmEmpty = buildFrontMatter(emptySource);
      if (fmEmpty !== '') {
        throw new Error(`FrontMatter must be empty string when all fields omitted: "${fmEmpty}"`);
      }

      // 2.4 buildResultFile: 正文为空时不创建只含来源的文件
      const emptyBlocksSnapshot = {
        snapshotId: 's1',
        capturedAt: new Date().toISOString(),
        source: fullSource,
        blocks: [],
        images: [],
        captureWarnings: [],
      };
      const resFileEmpty = buildResultFile(emptyBlocksSnapshot);
      if (resFileEmpty.text !== '' || resFileEmpty.body !== '') {
        throw new Error(`buildResultFile must return empty text when body is empty: "${resFileEmpty.text}"`);
      }

      const validBlocksSnapshot = {
        snapshotId: 's2',
        capturedAt: new Date().toISOString(),
        source: fullSource,
        blocks: sampleBlocks,
        images: [],
        captureWarnings: [],
      };
      const resFileValid = buildResultFile(validBlocksSnapshot);
      if (!resFileValid.text.startsWith('---\n') || !resFileValid.text.endsWith('\n')) {
        throw new Error(`buildResultFile text formatting incorrect: "${resFileValid.text}"`);
      }
      if (!resFileValid.text.includes(expectedMd)) {
        throw new Error(`buildResultFile body content missing in text: "${resFileValid.text}"`);
      }

      return true;
    });

    assert.strictEqual(dialectTestsPassed, true, 'Dialect unit tests must pass');
    console.log('✓ Test 2 Passed: Dialect functions (buildResultFile, buildMarkdown, buildFrontMatter) verified');

    // --------------------------------------------------------------------------
    // Test 3: Top Toolbar "检查结果" Entry & Visibility
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Top Toolbar "检查结果" Entry & Visibility ---');

    // 3.1 Initial empty state: toolbar and "检查结果" must NOT be rendered
    const hasPreviewBtnInEmpty = await page.$('[data-testid="action-preview"]');
    assert.strictEqual(hasPreviewBtnInEmpty, null, 'Action preview button must not exist in empty state');

    // 3.2 Initialize a cleaning session
    const testArticle = {
      kind: 'article',
      source: {
        title: '深度解析：分布式系统的弹性架构',
        account: '印厂技术谈',
        publishedAt: '2026-09-01',
        url: 'https://mp.weixin.qq.com/s/resilience-arch-2026',
      },
      contentHtml: `
        <h1>深度解析：分布式系统的弹性架构</h1>
        <p>这是第一段引言内容，讨论系统韧性。</p>
        <p>这是第二段被剔除的插话广告。</p>
        <table>
          <tr><td>参数</td><td>阈值</td></tr>
          <tr><td>超时</td><td>500ms</td></tr>
        </table>
        <p>这是包含图片的第四段：</p>
        <img src="https://mmbiz.qpic.cn/mmbiz_png/sample1/0?wx_fmt=png" alt="弹性架构拓扑图" />
        <p></p>
      `,
      unstable: false,
    };

    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, testArticle);

    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });

    // Tweak blocks: mark table block with table-degraded note, excluded paragraph excluded
    await page.evaluate(() => {
      const { dispatch, getState } = window.__wetrim;
      const state = getState();
      const blocks = state.session.snapshot.blocks.map((b) => {
        if (b.initialMarkdown.includes('剔除')) {
          return { ...b, included: false };
        }
        if (b.type === 'table') {
          return {
            ...b,
            included: true,
            notes: [
              {
                code: 'table-degraded',
                message: '表格包含合并单元格或复杂嵌套，已降级为可读文本',
              },
            ],
          };
        }
        return b;
      });

      dispatch({
        type: 'SET_NEW_SESSION',
        payload: {
          session: {
            ...state.session,
            snapshot: {
              ...state.session.snapshot,
              blocks,
            },
          },
          saveStatus: 'saved',
        },
      });
    });

    // 3.3 Verify "检查结果" button exists in cleaning mode right next to "回到原文看看"
    const previewBtn = await page.$('[data-testid="action-preview"]');
    assert(previewBtn !== null, 'Action preview button must exist in cleaning mode');
    const previewBtnText = await page.$eval('[data-testid="action-preview"]', (el) => el.textContent.trim());
    assert.strictEqual(previewBtnText, '检查结果', 'Button text must be "检查结果"');

    console.log('✓ Test 3 Passed: "检查结果" button rendered in header toolbar in cleaning mode');

    // --------------------------------------------------------------------------
    // Test 4: Modal Dialog Open & Focus & Return Behavior
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Modal Dialog Open, Focus & Return Behavior ---');

    // Click "检查结果" to open preview dialog
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    // 4.1 Focus must land on the view switcher tabs (default reading tab)
    const activeElementTag = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeElementTag, 'preview-tab-reading', 'Focus must land on reading preview tab upon opening');

    // 4.2 Stats line verification
    const statsText = await page.$eval('[data-testid="preview-stats-line"]', (el) => el.textContent.trim());
    console.log('Preview stats text:', statsText);
    assert(statsText.includes('保留'), 'Stats text must state included blocks count');

    // 4.3 Press Escape key to close dialog
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    // 4.4 Focus must return to "检查结果" button
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'action-preview',
      { timeout: 3000 }
    );
    const activeAfterEsc = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeAfterEsc, 'action-preview', 'Focus must return to action-preview button after Esc');

    // 4.5 Test "返回清洗" button closing
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
    await page.click('[data-testid="preview-btn-return"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'action-preview',
      { timeout: 3000 }
    );
    const activeAfterReturn = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeAfterReturn, 'action-preview', 'Focus must return to action-preview button after clicking 返回清洗');

    // 4.6 Test close "×" button closing
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
    await page.click('[data-testid="preview-btn-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'action-preview',
      { timeout: 3000 }
    );
    const activeAfterClose = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeAfterClose, 'action-preview', 'Focus must return to action-preview button after clicking ×');

    console.log('✓ Test 4 Passed: Dialog open, focus lands on tab, and closes cleanly returning focus to trigger button');

    // --------------------------------------------------------------------------
    // Test 5: Reading View & Markdown Source View with Lazy DOM Generation
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Reading View & Markdown Source View with Lazy DOM Generation ---');

    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    // 5.1 Reading View (阅读预览) verification
    const hasReadingPanel = await page.$eval('[data-testid="preview-panel-reading"]', (el) => el.style.display !== 'none');
    assert.strictEqual(hasReadingPanel, true, 'Reading preview panel must be displayed by default');

    // 稿头 verification
    const headerTitle = await page.$eval('[data-testid="preview-article-header"] .preview-article-title', (el) => el.textContent.trim());
    assert.strictEqual(headerTitle, '深度解析：分布式系统的弹性架构');

    const headerAccount = await page.$eval('.preview-meta-account', (el) => el.textContent.trim());
    assert(headerAccount.includes('印厂技术谈'), 'Account must be displayed in article header');

    const headerDate = await page.$eval('.preview-meta-date', (el) => el.textContent.trim());
    assert(headerDate.includes('2026-09-01'), 'Date must be displayed in article header');

    // Verify raw YAML is NOT shown in reading view
    const readingText = await page.$eval('[data-testid="preview-panel-reading"]', (el) => el.textContent);
    assert(!readingText.includes('---\ntitle:'), 'Raw YAML must not appear in reading preview');

    // 5.2 Lazy DOM: source <pre> must NOT exist yet!
    const preBeforeSwitch = await page.$('[data-testid="preview-source-pre"]');
    assert.strictEqual(preBeforeSwitch, null, 'Source <pre> DOM must NOT be created before user switches to source tab');

    // 5.3 Switch to Source Tab using keyboard ArrowRight
    await page.keyboard.press('ArrowRight');

    const activeTabAria = await page.$eval('[data-testid="preview-tab-source"]', (el) => el.getAttribute('aria-selected'));
    assert.strictEqual(activeTabAria, 'true', 'Source tab must become active upon ArrowRight');

    // 5.4 Now source <pre> DOM must be generated
    await page.waitForSelector('[data-testid="preview-source-pre"]', { timeout: 2000 });
    const preText = await page.$eval('[data-testid="preview-source-pre"]', (el) => el.textContent);
    assert(preText.includes('---\ntitle:'), 'Source pre must contain front-matter');
    assert(preText.includes('这是第一段引言内容'), 'Source pre must contain body markdown');
    assert(!preText.includes('这是第二段被剔除的插话广告'), 'Source pre must exclude excluded block');

    console.log('✓ Test 5 Passed: Reading view header/body verified and source view lazy DOM creation verified');

    // --------------------------------------------------------------------------
    // Test 6: Degradation Summary Bar & Navigation
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Degradation Summary Bar & Navigation ---');

    // 6.1 Verify degradation summary bar
    const degradationSummary = await page.$eval('[data-testid="degradation-summary-text"]', (el) => el.textContent.trim());
    console.log('Degradation summary bar:', degradationSummary);
    assert(degradationSummary.includes('表格降级 1 处'), 'Degradation summary must show "表格降级 1 处"');

    // 6.2 Toggle expand
    await page.click('[data-testid="degradation-summary-toggle"]');
    await page.waitForSelector('[data-testid="degradation-items-list"]', { timeout: 2000 });

    const itemText = await page.$eval('[data-testid="degradation-item-jump-btn"]', (el) => el.textContent.trim());
    const expectedOrder = await page.evaluate(
      () => window.__wetrim.getState().session.snapshot.blocks.find((b) => b.type === 'table')?.order
    );
    assert(
      itemText.includes(`#${expectedOrder}`) && itemText.includes('表格降级'),
      `Item must contain #${expectedOrder} and 表格降级`
    );

    // 6.3 Set cleaning page filter to 'excluded' so block 3 is currently hidden
    // Close preview first
    await page.click('[data-testid="preview-btn-return"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    // Switch filter to 'excluded'
    await page.click('[data-testid="filter-tab-excluded"]');
    const filterAfterClick = await page.evaluate(() => window.__wetrim.blockListRef.current.getFilter());
    assert.strictEqual(filterAfterClick, 'excluded', 'Main filter must be set to excluded');

    // Reopen preview
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    // Expand degradation bar and click item to jump
    await page.click('[data-testid="degradation-summary-toggle"]');
    await page.waitForSelector('[data-testid="degradation-items-list"]', { timeout: 2000 });

    await page.click('[data-testid="degradation-item-jump-btn"]');

    // 6.4 Preview dialog must close, filter must switch to 'all', and block 3 must be focused
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    await page.waitForFunction(() => window.__wetrim.blockListRef.current.getFilter() === 'all', { timeout: 3000 });
    const filterAfterJump = await page.evaluate(() => window.__wetrim.blockListRef.current.getFilter());
    assert.strictEqual(filterAfterJump, 'all', 'Filter must automatically switch to all when jumping to hidden block');

    const expectedTargetBlockId = await page.evaluate(
      () => window.__wetrim.getState().session.snapshot.blocks.find((b) => b.type === 'table')?.id
    );
    await page.waitForFunction(
      (id) => window.__wetrim.blockListRef.current.getFocusedBlockId() === id,
      { timeout: 3000 },
      expectedTargetBlockId
    );

    // 6.5 目标块在当前筛选下可见时（filter 已是 all），关闭后同样要聚焦到原块，而不是落回「检查结果」按钮
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
    await page.click('[data-testid="degradation-summary-toggle"]');
    await page.waitForSelector('[data-testid="degradation-items-list"]', { timeout: 2000 });
    await page.click('[data-testid="degradation-item-jump-btn"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
    await page.waitForFunction(
      (id) => window.__wetrim.blockListRef.current.getFocusedBlockId() === id,
      { timeout: 3000 },
      expectedTargetBlockId
    );
    await new Promise((r) => setTimeout(r, 300));
    const focusedAfterVisibleJump = await page.evaluate(() => window.__wetrim.blockListRef.current.getFocusedBlockId());
    assert.strictEqual(focusedAfterVisibleJump, expectedTargetBlockId, 'Visible target block must stay focused after dialog closes');

    console.log('✓ Test 6 Passed: Degradation summary bar counts, expands, and navigates back to block switching filter to all');

    // --------------------------------------------------------------------------
    // Test 6b: 防抖中的编辑进入预览，且对话框打开期间不刷新
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6b: Pending Edits Flushed on Open & Frozen While Open ---');

    const editTargetId = await page.evaluate(
      () => window.__wetrim.getState().session.snapshot.blocks.find((b) => b.initialMarkdown.includes('第一段引言'))?.id
    );
    await page.click(`[data-block-id="${editTargetId}"] [data-testid="block-action-edit"]`);
    await page.waitForSelector(`[data-block-id="${editTargetId}"] [data-testid="block-editor-textarea"]`);
    await page.type(`[data-block-id="${editTargetId}"] [data-testid="block-editor-textarea"]`, '防抖未落盘的补充');
    // 500ms 防抖到期前立即打开
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
    await page.click('[data-testid="preview-tab-source"]');
    await page.waitForSelector('[data-testid="preview-source-pre"]', { timeout: 2000 });
    const preWithPending = await page.$eval('[data-testid="preview-source-pre"]', (el) => el.textContent);
    assert(preWithPending.includes('防抖未落盘的补充'), 'Preview must include edits still pending in the debounce window');

    // 打开期间快照被改写，预览内容保持不变
    await page.evaluate((id) => {
      window.__wetrim.dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: id, editedMarkdown: '打开期间的迟到改写' } });
    }, editTargetId);
    await new Promise((r) => setTimeout(r, 200));
    const preAfterLateWrite = await page.$eval('[data-testid="preview-source-pre"]', (el) => el.textContent);
    assert.strictEqual(preAfterLateWrite, preWithPending, 'Preview must not refresh while the dialog is open');

    await page.click('[data-testid="preview-btn-return"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
    await page.click(`[data-block-id="${editTargetId}"] [data-testid="block-action-finish-edit"]`);

    console.log('✓ Test 6b Passed: Pending edits flushed before generation and preview frozen while open');

    // --------------------------------------------------------------------------
    // Test 7: Empty State Handlers
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Empty State Handlers ---');

    // 7.1 Case A: All blocks excluded
    await page.evaluate(() => {
      const { dispatch, getState } = window.__wetrim;
      const state = getState();
      const allExcludedBlocks = state.session.snapshot.blocks.map((b) => ({ ...b, included: false }));
      dispatch({
        type: 'SET_NEW_SESSION',
        payload: {
          session: {
            ...state.session,
            snapshot: {
              ...state.session.snapshot,
              blocks: allExcludedBlocks,
            },
          },
          saveStatus: 'saved',
        },
      });
    });

    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    const emptyTitleAllExcluded = await page.$eval('[data-testid="preview-empty-state"] .empty-state-title', (el) => el.textContent.trim());
    assert.strictEqual(emptyTitleAllExcluded, '没有可导出的正文');

    const recoverBtn = await page.$('[data-testid="preview-btn-recover-excluded"]');
    assert(recoverBtn !== null, 'Button "去找回剔除的块" must be rendered');

    // Click recover button: must close preview and switch filter to 'excluded'
    await page.click('[data-testid="preview-btn-recover-excluded"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    await page.waitForFunction(() => window.__wetrim.blockListRef.current.getFilter() === 'excluded', { timeout: 3000 });
    const filterAfterRecover = await page.evaluate(() => window.__wetrim.blockListRef.current.getFilter());
    assert.strictEqual(filterAfterRecover, 'excluded', 'Filter must switch to excluded after clicking recover');

    // 7.2 Case B: Included blocks all empty
    await page.evaluate(() => {
      const { dispatch, getState } = window.__wetrim;
      const state = getState();
      const allEmptyBlocks = state.session.snapshot.blocks.map((b) => ({
        ...b,
        included: true,
        editedMarkdown: '',
      }));
      dispatch({
        type: 'SET_NEW_SESSION',
        payload: {
          session: {
            ...state.session,
            snapshot: {
              ...state.session.snapshot,
              blocks: allEmptyBlocks,
            },
          },
          saveStatus: 'saved',
        },
      });
    });

    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    const jumpFirstEmptyBtn = await page.$('[data-testid="preview-btn-jump-first-empty"]');
    assert(jumpFirstEmptyBtn !== null, 'Button "跳到第一个空块" must be rendered');

    await page.click('[data-testid="preview-btn-jump-first-empty"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    await page.waitForFunction(() => window.__wetrim.blockListRef.current.getFocusedBlockId() !== null, {
      timeout: 3000,
    });

    console.log('✓ Test 7 Passed: Empty states correctly show guidance and recovery buttons');

    // --------------------------------------------------------------------------
    // Test 8: 4× CPU Slowdown 600-Block Performance Benchmark (Budget ≤ 300 ms)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: 4× CPU Slowdown 600-Block Performance Benchmark ---');

    const client = await page.createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    console.log('==> CPU throttling set to 4× slowdown');

    // Generate 600 synthetic blocks with various types and images
    const synthetic600 = [];
    for (let i = 1; i <= 600; i++) {
      const isImg = i % 25 === 0;
      const isTable = i % 50 === 0;
      const isHeading = i % 15 === 0;
      synthetic600.push({
        id: `synth-perf-${i}`,
        order: i,
        type: isHeading ? 'heading' : isImg ? 'image' : isTable ? 'table' : 'paragraph',
        headingLevel: isHeading ? 2 : undefined,
        originalHtml: isImg
          ? `<img src="https://example.com/synth-${i}.png" alt="图 ${i}" />`
          : `<p>第 ${i} 块合成长文段落内容：系统架构与持久化规范说明。</p>`,
        initialMarkdown: isImg
          ? `![图 ${i}](https://example.com/synth-${i}.png)`
          : `第 ${i} 块合成长文段落内容：系统架构与持久化规范说明。`.repeat(i % 3 === 0 ? 12 : 1) +
            (i % 7 === 0 ? `**强调 ${i}** 与 [链接](https://example.com/${i}) 以及 \`code-${i}\`。` : ''),
        editedMarkdown: null,
        included: i % 10 !== 0, // 90% 保留 (~540 块)
        notes: isTable
          ? [
              {
                code: 'table-degraded',
                message: '表格降级提示',
              },
            ]
          : [],
      });
    }

    await page.evaluate((blocks) => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-perf-600',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              snapshotId: 'snap-perf-600',
              capturedAt: new Date().toISOString(),
              source: {
                url: 'https://example.com/synth-600',
                title: '600块合成长文检查结果性能基准',
                account: '印厂技术谈',
                publishedAt: '2026-09-01',
              },
              blocks,
              images: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, synthetic600);

    // Warm-up and wait for main cleaning page to mount blocks
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length > 500, {
      timeout: 20000,
    });

    // Measure: 从点击「检查结果」按钮起，到对话框打开且正文内容完成绘制（双 requestAnimationFrame 确保完成布局与绘制）
    console.log('==> Measuring preview dialog open and draw latency on 600 blocks @ 4× CPU slowdown...');

    const perfResult = await page.evaluate(async () => {
      const btn = document.querySelector('[data-testid="action-preview"]');
      const t0 = performance.now();
      btn.click();

      await new Promise((resolve) => {
        function poll() {
          const dialog = document.querySelector('[data-testid="preview-dialog"]');
          const content = dialog?.querySelector('[data-testid="preview-article-content"]');
          if (dialog && dialog.hasAttribute('open') && content && content.childNodes.length > 0) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          } else {
            setTimeout(poll, 2);
          }
        }
        poll();
      });

      const t1 = performance.now();
      return { latency: t1 - t0 };
    });

    console.log(`[Perf @ 4× CPU 600 Blocks] Click-to-draw complete latency: ${perfResult.latency.toFixed(2)} ms (budget ≤ 300 ms)`);
    console.log('口径：从点击「检查结果」按钮时刻起，至 <dialog> 打开且正文 .preview-article-content 挂载完毕，并完成连续两帧 requestAnimationFrame 回调确保 React 提交、样式计算、DOM 布局与像素绘制完成为止的全部端到端耗时。');

    assert(
      perfResult.latency <= 300,
      `Preview dialog draw latency ${perfResult.latency.toFixed(2)} ms must be ≤ 300 ms on 600 blocks @ 4× CPU slowdown`
    );

    // Reset CPU throttling
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log('✓ Test 8 Passed: 600-block preview generation & paint well within ≤ 300 ms budget');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    // --------------------------------------------------------------------------
    // Test 9: 返回清洗后滚动位置与编辑状态不丢失（沿用 Test 8 的 600 块长文）
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Scroll Position & Editor State Survive Preview Round-trip ---');

    await page.evaluate(() => window.scrollTo({ top: 20000, behavior: 'instant' }));
    await new Promise((r) => setTimeout(r, 300));

    // 取视口内第一个位于顶栏下方的保留块，直接点它的编辑按钮（已在视口内，点击不会引发滚动）
    const t9TargetId = await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-testid="block-item"]')) {
        const rect = el.getBoundingClientRect();
        const id = el.getAttribute('data-block-id');
        const block = window.__wetrim.getState().session.snapshot.blocks.find((b) => b.id === id);
        if (rect.top > 150 && rect.bottom < window.innerHeight && block?.included && block.type === 'paragraph') {
          return id;
        }
      }
      return null;
    });
    assert(t9TargetId, 'Must find a visible paragraph block in the middle of the long article');

    await page.click(`[data-block-id="${t9TargetId}"] [data-testid="block-action-edit"]`);
    const t9Textarea = `[data-block-id="${t9TargetId}"] [data-testid="block-editor-textarea"]`;
    await page.waitForSelector(t9Textarea);
    await page.type(t9Textarea, '【已落盘的编辑】');
    await new Promise((r) => setTimeout(r, 800)); // 越过 500ms 防抖
    await page.type(t9Textarea, '【防抖窗口内的编辑】');

    const t9Before = await page.evaluate((sel) => {
      const ta = document.querySelector(sel);
      window.__t9Textarea = ta;
      return {
        scrollY: window.scrollY,
        value: ta.value,
        filter: window.__wetrim.blockListRef.current.getFilter(),
      };
    }, t9Textarea);
    assert(t9Before.scrollY > 10000, `Page must be scrolled deep into the article, got scrollY=${t9Before.scrollY}`);

    for (const [label, closeAction] of [
      ['Esc', () => page.keyboard.press('Escape')],
      ['返回清洗', () => page.click('[data-testid="preview-btn-return"]')],
      ['×', () => page.click('[data-testid="preview-btn-close"]')],
    ]) {
      await page.click('[data-testid="action-preview"]');
      await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
      await closeAction();
      await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('data-testid') === 'action-preview',
        { timeout: 3000 }
      );
      await new Promise((r) => setTimeout(r, 200));

      const t9After = await page.evaluate((sel) => {
        const ta = document.querySelector(sel);
        return {
          scrollY: window.scrollY,
          sameTextarea: ta !== null && ta === window.__t9Textarea && ta.isConnected,
          value: ta?.value ?? null,
          filter: window.__wetrim.blockListRef.current.getFilter(),
        };
      }, t9Textarea);

      assert(
        Math.abs(t9After.scrollY - t9Before.scrollY) <= 1,
        `[${label}] Scroll position must be kept: before=${t9Before.scrollY}, after=${t9After.scrollY}`
      );
      assert.strictEqual(t9After.sameTextarea, true, `[${label}] Open editor must stay mounted (same textarea node)`);
      assert.strictEqual(t9After.value, t9Before.value, `[${label}] Editor text must be kept`);
      assert.strictEqual(t9After.filter, t9Before.filter, `[${label}] Filter must be kept`);
    }

    const t9Stored = await page.evaluate(
      (id) => window.__wetrim.getState().session.snapshot.blocks.find((b) => b.id === id)?.editedMarkdown,
      t9TargetId
    );
    assert(
      t9Stored?.includes('【已落盘的编辑】') && t9Stored.includes('【防抖窗口内的编辑】'),
      'Edits (including the one pending at open time) must be kept in session state'
    );

    await page.click(`[data-block-id="${t9TargetId}"] [data-testid="block-action-finish-edit"]`);
    console.log(`✓ Test 9 Passed: scrollY=${t9Before.scrollY} kept, open editor and its text kept across Esc / 返回清洗 / ×`);

    // --------------------------------------------------------------------------
    // Test 10: 阅读预览经 marked + DOMPurify 渲染，危险内容被净化；降级按 note code 计数提示
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: marked + DOMPurify Sanitization & Degradation Notice ---');

    const unitSanitized = await page.evaluate(() =>
      window.__wetrim.renderMarkdown('**粗** <script>window.__xssUnit=1</script><img src=x onerror="window.__xssUnit=1">')
    );
    assert(unitSanitized.includes('<strong>粗</strong>'), 'renderMarkdown must render Markdown via marked');
    assert(!/<script|onerror/i.test(unitSanitized), `renderMarkdown must sanitize output, got: ${unitSanitized}`);

    const mkBlock = (order, type, markdown, notes = []) => ({
      id: `xss-${order}`,
      order,
      type,
      originalHtml: '<p></p>',
      initialMarkdown: markdown,
      editedMarkdown: null,
      included: true,
      notes,
    });
    const xssBlocks = [
      mkBlock(1, 'paragraph', '**粗体标记** 与 *斜体标记*'),
      mkBlock(2, 'paragraph', '<script>window.__xssScript = 1</script>脚本之后的文字'),
      mkBlock(3, 'paragraph', '<img src="https://invalid.example/x.png" onerror="window.__xssImg = 1">'),
      mkBlock(4, 'paragraph', '[危险链接](javascript:window.__xssLink=1) 与 <a href="#" onclick="window.__xssClick=1">点我</a>'),
      mkBlock(5, 'paragraph', '<iframe src="https://invalid.example/"></iframe><object data="https://invalid.example/"></object><form action="https://invalid.example/"><input name="q"></form>框架之后'),
      mkBlock(6, 'table', '参数：超时 500ms', [{ code: 'table-degraded', message: '表格降级' }]),
      mkBlock(7, 'richMedia', '[视频：弹性架构演示]', [{ code: 'richmedia-placeholder', message: '富媒体占位' }]),
      mkBlock(8, 'unknown', '无法识别的内容', [{ code: 'convert-failed', message: '未知内容' }]),
      mkBlock(9, 'list', '- [ ] 待办事项\n- [x] 已办事项'),
      { ...mkBlock(10, 'paragraph', '被剔除的广告段落'), included: false },
    ];

    await page.evaluate((blocks) => {
      window.__wetrim.dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-xss',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              snapshotId: 'snap-xss',
              capturedAt: new Date().toISOString(),
              source: { url: 'https://example.com/xss', title: '净化测试', account: null, publishedAt: null },
              blocks,
              images: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    }, xssBlocks);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 10, {
      timeout: 5000,
    });

    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });
    await page.waitForSelector('[data-testid="preview-article-content"]');

    // 触发内联事件处理器的机会：等待图片出错、点击残留链接
    await page.evaluate(() => {
      for (const a of document.querySelectorAll('[data-testid="preview-article-content"] a')) {
        a.addEventListener('click', (e) => e.preventDefault(), { once: true });
        a.click();
      }
    });
    await new Promise((r) => setTimeout(r, 800));

    const t10 = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="preview-article-content"]');
      const all = [...content.querySelectorAll('*')];
      return {
        strong: content.querySelector('strong')?.textContent ?? null,
        em: content.querySelector('em')?.textContent ?? null,
        text: content.textContent,
        dangerousTags: all.filter((el) => /^(SCRIPT|IFRAME|OBJECT|EMBED|FORM)$/.test(el.tagName)).map((el) => el.tagName),
        inlineHandlers: all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}.${a.name}`)),
        taskCheckboxes: content.querySelectorAll('li > input[type="checkbox"]').length,
        jsHrefs: all.filter((el) => /^\s*javascript:/i.test(el.getAttribute('href') ?? '')).length,
        fired: ['__xssScript', '__xssImg', '__xssLink', '__xssClick', '__xssUnit'].filter((k) => k in window),
        summary: document.querySelector('[data-testid="degradation-summary-text"]')?.textContent.trim() ?? null,
      };
    });

    assert.strictEqual(t10.strong, '粗体标记', 'Markdown bold must render as <strong> via marked');
    assert.strictEqual(t10.em, '斜体标记', 'Markdown emphasis must render as <em> via marked');
    assert(t10.text.includes('脚本之后的文字') && t10.text.includes('框架之后'), 'Safe text around stripped tags must remain');
    assert.deepStrictEqual(t10.dangerousTags, [], `No script/iframe/object/embed/form may survive, got ${t10.dangerousTags}`);
    assert.deepStrictEqual(t10.inlineHandlers, [], `No inline event handlers may survive, got ${t10.inlineHandlers}`);
    assert.strictEqual(t10.taskCheckboxes, 2, 'GFM task list checkboxes must survive sanitization');
    assert.strictEqual(t10.jsHrefs, 0, 'No javascript: hrefs may survive');
    assert.deepStrictEqual(t10.fired, [], `No injected code may execute, got ${t10.fired}`);
    assert.strictEqual(
      t10.summary,
      '表格降级 1 处 · 富媒体占位 1 处 · 未知内容 1 处',
      `Degradation summary must count by note code, got: ${t10.summary}`
    );

    // 源码视图以纯文本呈现原始 Markdown，不解析其中的 HTML
    await page.click('[data-testid="preview-tab-source"]');
    await page.waitForSelector('[data-testid="preview-source-pre"]', { timeout: 2000 });
    const t10Source = await page.$eval('[data-testid="preview-source-pre"]', (el) => ({
      text: el.textContent,
      childElements: el.querySelectorAll('script, iframe, img').length,
    }));
    assert(t10Source.text.includes('<script>window.__xssScript = 1</script>'), 'Source view must show raw Markdown text');
    assert.strictEqual(t10Source.childElements, 0, 'Source view must not parse Markdown HTML into elements');
    // 表格降级、富媒体占位与未知内容块按其当前 Markdown 原样进入正文，提示不混入正文；剔除块不留标记
    for (const kept of ['参数：超时 500ms', '[视频：弹性架构演示]', '无法识别的内容', '- [ ] 待办事项\n- [x] 已办事项']) {
      assert(t10Source.text.includes(kept), `Source must contain kept block content: ${kept}`);
    }
    for (const absent of ['被剔除的广告段落', '表格降级', '富媒体占位', '未知内容']) {
      assert(!t10Source.text.includes(absent), `Source must not contain: ${absent}`);
    }

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));
    console.log('✓ Test 10 Passed: marked renders, DOMPurify strips script/iframe/object/form/handlers/javascript: hrefs (task checkboxes kept), placeholder rules hold, degradation counted by code');

    console.log('\n=======================================================');
    console.log('🎉 ALL ISSUE #31 VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('=======================================================');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Issue #31 Verification FAILED with error:');
  console.error(err);
  process.exit(1);
});
