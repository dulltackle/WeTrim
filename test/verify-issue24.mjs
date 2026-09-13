import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #24 Verification (Clean View Skeleton & BlockList Seam)...');

  // --------------------------------------------------------------------------
  // Test 1: CI DOM access check rule
  // --------------------------------------------------------------------------
  console.log('\n--- Test 1: CI DOM access check rule outside BlockList ---');
  const domCheckPassed = checkDomAccess();
  assert.strictEqual(domCheckPassed, true, 'check-dom-access.mjs must pass with 0 violations in src/app');
  console.log('✓ Test 1 Passed: No direct DOM queries outside BlockList in src/app');

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
    // Set standard viewport
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 2: Top-level 4-state state machine
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Top-level 4-state state machine (empty, cleaning, candidateConfirm, corruptedRecord) ---');

    // 2.1 Default Empty state (3-step guide)
    const emptyState = await page.evaluate(() => {
      const container = document.querySelector('.app-container');
      const viewMode = container?.getAttribute('data-view-mode');
      const emptyView = document.querySelector('[data-testid="empty-state-view"]');
      const steps = document.querySelector('.rendered-steps');
      const headerTag = document.querySelector('.ticket-tag')?.textContent?.trim();
      return {
        viewMode,
        hasEmptyView: Boolean(emptyView),
        hasSteps: Boolean(steps && steps.textContent?.includes('点工具栏上的 WeTrim 图标')),
        headerTag,
      };
    });
    assert.strictEqual(emptyState.viewMode, 'empty', 'Initial view mode must be "empty"');
    assert.strictEqual(emptyState.hasEmptyView, true, 'Default empty state view must be visible');
    assert.strictEqual(emptyState.hasSteps, true, '3-step guide must be rendered');
    assert.strictEqual(emptyState.headerTag, '待稿', 'Header tag should be "待稿" in empty state');

    // 2.2 Empty state sub-view: Wechat notice card (审校退单)
    await page.evaluate(() => {
      const { processCaptureResult } = window.__wetrim;
      processCaptureResult({
        kind: 'wechatNotice',
        noticeText: '该公众号已被封禁',
      });
    });
    const noticeState = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="return-notice-card"]');
      const quote = card?.querySelector('.notice-verbatim-quote')?.textContent?.trim();
      const stamp = card?.querySelector('.notice-stamp')?.textContent?.trim();
      return {
        hasCard: Boolean(card),
        quote,
        stamp,
      };
    });
    assert.strictEqual(noticeState.hasCard, true, 'Wechat notice card must be rendered in empty mode');
    assert(noticeState.quote?.includes('该公众号已被封禁'), 'Notice card must quote verbatim text');
    assert.strictEqual(noticeState.stamp, '退单', 'Notice stamp should say "退单"');

    // 2.3 Empty state sub-view: Split error card (整篇级失败)
    await page.evaluate(() => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'SET_SPLIT_ERROR',
        payload: { message: 'DOM 结构损坏', url: 'https://mp.weixin.qq.com/s/sample' },
      });
    });
    const splitErrorState = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="article-failure-card"]');
      const title = card?.querySelector('.notice-title')?.textContent?.trim();
      const quote = card?.querySelector('.notice-verbatim-quote')?.textContent?.trim();
      return {
        hasCard: Boolean(card),
        title,
        quote,
      };
    });
    assert.strictEqual(splitErrorState.hasCard, true, 'Article failure card must be rendered on split error');
    assert(splitErrorState.quote?.includes('DOM 结构损坏'), 'Failure card must display error message');

    // 2.4 Candidate confirm state (候选确认态 - #24 最小壳)
    await page.evaluate(() => {
      const { dispatch } = window.__wetrim;
      // 先设当前会话
      dispatch({
        type: 'SET_ARTICLE_SNAPSHOT',
        payload: {
          snapshotId: 'snap-1',
          capturedAt: new Date().toISOString(),
          source: { title: '第一篇已在清洗文章', account: '作者A', publishedAt: '2026-09-01', url: 'https://mp.weixin.qq.com/s/1' },
          blocks: [
            {
              id: 'b-1',
              order: 1,
              type: 'paragraph',
              originalHtml: '<p>第一篇正文</p>',
              initialMarkdown: '第一篇正文',
              editedMarkdown: null,
              included: true,
              notes: [],
            },
          ],
          images: [],
          captureWarnings: [],
        },
      });
      // 再次传入新快照，已有当前会话时触发 candidateConfirm
      dispatch({
        type: 'SET_ARTICLE_SNAPSHOT',
        payload: {
          snapshotId: 'snap-2',
          capturedAt: new Date().toISOString(),
          source: { title: '新抓取的第二篇文章', account: '作者B', publishedAt: '2026-09-02', url: 'https://mp.weixin.qq.com/s/2' },
          blocks: [],
          images: [],
          captureWarnings: [],
        },
      });
    });

    const candidateState = await page.evaluate(() => {
      const container = document.querySelector('.app-container');
      const viewMode = container?.getAttribute('data-view-mode');
      const card = document.querySelector('[data-testid="candidate-confirm-card"]');
      const title = card?.querySelector('.notice-title')?.textContent?.trim();
      const quote = card?.querySelector('.notice-verbatim-quote')?.textContent?.trim();
      const tip = card?.querySelector('.state-placeholder-tip')?.textContent?.trim();
      const stamp = card?.querySelector('.notice-stamp')?.textContent?.trim();
      return {
        viewMode,
        hasCard: Boolean(card),
        title,
        quote,
        tip,
        stamp,
      };
    });
    assert.strictEqual(candidateState.viewMode, 'candidateConfirm', 'View mode must be "candidateConfirm"');
    assert.strictEqual(candidateState.hasCard, true, 'Candidate confirm shell card must be rendered');
    assert.strictEqual(candidateState.stamp, '待确认', 'Candidate stamp must say "待确认"');
    assert(candidateState.quote?.includes('新抓取的第二篇文章'), 'Candidate card must mention candidate article title');
    assert(candidateState.tip?.includes('#28'), 'Candidate card must mention #28 placeholder');

    // 2.5 Corrupted record state (损坏记录态 - #24 最小壳)
    await page.evaluate(() => {
      const { dispatch } = window.__wetrim;
      dispatch({
        type: 'SET_CORRUPTED_RECORD',
        payload: '存储数据校验失败：缺失 snapshotId',
      });
    });

    const corruptedState = await page.evaluate(() => {
      const container = document.querySelector('.app-container');
      const viewMode = container?.getAttribute('data-view-mode');
      const card = document.querySelector('[data-testid="corrupted-record-card"]');
      const title = card?.querySelector('.notice-title')?.textContent?.trim();
      const quote = card?.querySelector('.notice-verbatim-quote')?.textContent?.trim();
      const tip = card?.querySelector('.state-placeholder-tip')?.textContent?.trim();
      return {
        viewMode,
        hasCard: Boolean(card),
        title,
        quote,
        tip,
      };
    });
    assert.strictEqual(corruptedState.viewMode, 'corruptedRecord', 'View mode must be "corruptedRecord"');
    assert.strictEqual(corruptedState.hasCard, true, 'Corrupted record shell card must be rendered');
    assert(corruptedState.quote?.includes('缺失 snapshotId'), 'Corrupted card must display details');
    assert(corruptedState.tip?.includes('#35'), 'Corrupted card must mention #35 placeholder');

    console.log('✓ Test 2 Passed: 4-state state machine renders correctly');

    // --------------------------------------------------------------------------
    // Test 3: BlockItem 6 States with explicit text & semantic HTML rendering
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: BlockItem 6 States with explicit text & semantic rendering ---');

    await page.evaluate(() => {
      const { dispatch } = window.__wetrim;
      const testBlocks = [
        // 1. Heading block with level H2
        {
          id: 'test-h2',
          order: 1,
          type: 'heading',
          headingLevel: 2,
          originalHtml: '<h2>第二节：细胞骨架</h2>',
          initialMarkdown: '## 第二节：细胞骨架',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        // 2. Paragraph block with text
        {
          id: 'test-p',
          order: 2,
          type: 'paragraph',
          originalHtml: '<p>骨骼由成骨细胞和破骨细胞共同维持。</p>',
          initialMarkdown: '骨骼由成骨细胞和破骨细胞共同维持。',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        // 3. Excluded block (included === false)
        {
          id: 'test-excluded',
          order: 3,
          type: 'paragraph',
          originalHtml: '<p>这是一段被剔除的广告内容</p>',
          initialMarkdown: '这是一段被剔除的广告内容',
          editedMarkdown: null,
          included: false,
          notes: [],
        },
        // 4. Edited block (editedMarkdown !== null)
        {
          id: 'test-edited',
          order: 4,
          type: 'paragraph',
          originalHtml: '<p>原始文本</p>',
          initialMarkdown: '原始文本',
          editedMarkdown: '用户已修改后的文本',
          included: true,
          notes: [],
        },
        // 5. Empty content block (currentMarkdown.trim() === '')
        {
          id: 'test-empty',
          order: 5,
          type: 'paragraph',
          originalHtml: '<p></p>',
          initialMarkdown: '',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
        // 6. Table block
        {
          id: 'test-table',
          order: 6,
          type: 'table',
          originalHtml: '<table><tr><th>阶段</th><th>指标</th></tr><tr><td>I</td><td>100</td></tr></table>',
          initialMarkdown: '| 阶段 | 指标 |\n| --- | --- |\n| I | 100 |',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
      ];

      dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-states',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: {
              snapshotId: 'snap-states',
              capturedAt: new Date().toISOString(),
              source: {
                title: '六类状态渲染验证文章',
                account: '医学科普',
                publishedAt: '2026-09-10',
                url: 'https://mp.weixin.qq.com/s/states',
              },
              blocks: testBlocks,
              images: [],
              captureWarnings: [],
            },
          },
          candidateSnapshot: null,
          corrupted: false,
        },
      });
    });

    const blockItemStates = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      return items.map((el) => {
        const id = el.getAttribute('data-block-id');
        const orderBadge = el.querySelector('[data-testid="block-order-badge"]')?.textContent?.trim();
        const typeBadge = el.querySelector('[data-testid="block-type-badge"]')?.textContent?.trim();
        const statusTag = el.querySelector('[data-testid="block-status-tag"]')?.textContent?.trim();
        const editedBadge = el.querySelector('[data-testid="block-edited-badge"]')?.textContent?.trim();
        const emptyBadge = el.querySelector('[data-testid="block-empty-badge"]')?.textContent?.trim();
        const emptyPlaceholder = el.querySelector('[data-testid="block-empty-placeholder"]')?.textContent?.trim();
        const renderedContent = el.querySelector('[data-testid="block-rendered-content"]');
        const semanticTags = renderedContent
          ? Array.from(renderedContent.querySelectorAll('*')).map((c) => c.tagName.toLowerCase())
          : [];
        const contentText = renderedContent?.textContent?.trim() || '';

        return {
          id,
          orderBadge,
          typeBadge,
          statusTag,
          editedBadge: editedBadge || null,
          emptyBadge: emptyBadge || null,
          emptyPlaceholder: emptyPlaceholder || null,
          semanticTags,
          contentText,
        };
      });
    });

    // 1. Heading block
    const h2Block = blockItemStates.find((b) => b.id === 'test-h2');
    assert(h2Block, 'Heading block must exist');
    assert.strictEqual(h2Block.orderBadge, '#1', 'Order must be formatted with text #1');
    assert(h2Block.typeBadge.includes('标题'), 'Type badge must contain text "标题"');
    assert(h2Block.typeBadge.includes('H2'), 'Type badge must contain text "H2"');
    assert.strictEqual(h2Block.statusTag, '保留', 'Status tag must say "保留"');
    assert(h2Block.semanticTags.includes('h2'), 'Heading must be rendered with semantic <h2> tag');
    assert.strictEqual(h2Block.contentText, '第二节：细胞骨架');

    // 2. Excluded block
    const excludedBlock = blockItemStates.find((b) => b.id === 'test-excluded');
    assert(excludedBlock, 'Excluded block must exist');
    assert.strictEqual(excludedBlock.statusTag, '剔除', 'Status tag must say "剔除"');

    // 3. Edited block
    const editedBlock = blockItemStates.find((b) => b.id === 'test-edited');
    assert(editedBlock, 'Edited block must exist');
    assert.strictEqual(editedBlock.editedBadge, '已修改', 'Edited block must show "已修改" text badge');
    assert.strictEqual(editedBlock.contentText, '用户已修改后的文本');

    // 4. Empty block
    const emptyBlock = blockItemStates.find((b) => b.id === 'test-empty');
    assert(emptyBlock, 'Empty block must exist');
    assert.strictEqual(emptyBlock.emptyBadge, '内容为空', 'Empty block must show "内容为空" text badge');
    assert.strictEqual(emptyBlock.emptyPlaceholder, '（内容为空）', 'Empty block must show text placeholder "（内容为空）"');

    // 5. Table block
    const tableBlock = blockItemStates.find((b) => b.id === 'test-table');
    assert(tableBlock, 'Table block must exist');
    assert(tableBlock.typeBadge.includes('表格'), 'Type badge must say "表格"');
    assert(tableBlock.semanticTags.includes('table'), 'Table block must render semantic <table> tag');
    assert(tableBlock.semanticTags.includes('th'), 'Table block must render <th> tag');
    assert(tableBlock.semanticTags.includes('td'), 'Table block must render <td> tag');

    // Article title & metadata positioned BEFORE content blocks
    const layoutOrder = await page.evaluate(() => {
      const slipHeader = document.querySelector('[data-testid="slip-header"]');
      const blockList = document.querySelector('[data-testid="block-list"]');
      const volumeStats = document.querySelector('.volume-stats-grid');
      return {
        hasSlipHeader: Boolean(slipHeader),
        headerBeforeList: slipHeader && blockList && (slipHeader.compareDocumentPosition(blockList) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        volumeStatsRemoved: !volumeStats,
        headerTitle: slipHeader?.querySelector('.slip-title')?.textContent?.trim(),
      };
    });
    assert.strictEqual(layoutOrder.hasSlipHeader, true, 'Slip header must exist');
    assert.strictEqual(layoutOrder.headerBeforeList, true, 'Article title and source must precede BlockList in DOM');
    assert.strictEqual(layoutOrder.volumeStatsRemoved, true, 'Diagnostic volume-stats-grid must be removed per Issue #24');
    assert.strictEqual(layoutOrder.headerTitle, '六类状态渲染验证文章');

    console.log('✓ Test 3 Passed: All 6 block states, semantic tags, and layout order verified');

    // --------------------------------------------------------------------------
    // Test 4: BlockList Seam & Ref Interface (scrollToBlock, focusBlock, queryVisible)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: BlockList Ref Interface (scrollToBlock, focusBlock, queryVisible) ---');

    const seamTest = await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      const ref = blockListRef.current;
      if (!ref) {
        return { error: 'blockListRef is null' };
      }

      // 1. Check API presence
      const hasScroll = typeof ref.scrollToBlock === 'function';
      const hasFocus = typeof ref.focusBlock === 'function';
      const hasQuery = typeof ref.queryVisible === 'function';

      // 2. Test focusBlock on block 'test-p'
      ref.focusBlock('test-p');
      const activeId = document.activeElement?.getAttribute('data-block-id');

      // 3. Test queryVisible
      const visibleIds = ref.queryVisible();

      return {
        hasScroll,
        hasFocus,
        hasQuery,
        activeId,
        visibleIdsCount: visibleIds.length,
        visibleIdsIncludesTarget: visibleIds.includes('test-p'),
      };
    });

    assert.strictEqual(seamTest.hasScroll, true, 'ref.scrollToBlock must be a function');
    assert.strictEqual(seamTest.hasFocus, true, 'ref.focusBlock must be a function');
    assert.strictEqual(seamTest.hasQuery, true, 'ref.queryVisible must be a function');
    assert.strictEqual(seamTest.activeId, 'test-p', 'ref.focusBlock must move DOM focus to target block element');
    assert(seamTest.visibleIdsCount > 0, 'ref.queryVisible must return visible block IDs');
    assert.strictEqual(seamTest.visibleIdsIncludesTarget, true, 'queryVisible must include focused block');

    console.log('✓ Test 4 Passed: BlockList ref interface (scrollToBlock, focusBlock, queryVisible) verified');

    // --------------------------------------------------------------------------
    // Test 5: Real 347-Block Long-form Benchmark ("每10年换一副骨架...")
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Real 347-Block Long-form Benchmark ("每10年换一副骨架...") ---');

    const longformData = JSON.parse(
      execSync('git show 64d097d:output/wayfinder-12/samples/wetrim-sample-deep-longform.json', {
        maxBuffer: 50 * 1024 * 1024,
      })
    );

    // 5.1 加载 347 块快照并分发进入 cleaning 状态
    const totalBlocksCount = await page.evaluate(
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
              sessionId: 'sess-longform-347',
              revision: 1,
              savedAt: new Date().toISOString(),
              snapshot,
            },
            candidateSnapshot: null,
            corrupted: false,
          },
        });

        return snapshot.blocks.length;
      },
      {
        html: longformData.RESULTS.content.after.html,
        url: longformData.RESULTS.content.meta?.url || 'https://mp.weixin.qq.com/s/deep',
        title: longformData.RESULTS.content.meta?.title || '每10年换一副骨架',
      }
    );

    // 等待 React 完成 347 块的连续渲染
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 347, {
      timeout: 10000,
    });

    const longformTest = await page.evaluate(() => {
      const { blockListRef } = window.__wetrim;
      // 验证 DOM 中渲染的块
      const renderedItems = document.querySelectorAll('[data-testid="block-item"]');
      const summaryTotalText = document.querySelector('[data-testid="summary-total-blocks"]')?.textContent?.trim();

      const renderedCount = renderedItems.length;

      // 检查各类型分布
      const typesMap = {};
      for (const item of Array.from(renderedItems)) {
        const t = item.getAttribute('data-block-type');
        typesMap[t] = (typesMap[t] || 0) + 1;
      }

      // 检查首块与末块顺序
      const firstOrder = renderedItems[0]?.getAttribute('data-block-order');
      const lastOrder = renderedItems[renderedItems.length - 1]?.getAttribute('data-block-order');

      // 测试 queryVisible 在长文中的真实表现
      const visibleIds = blockListRef.current?.queryVisible() || [];

      // 测试定位到第 150 块
      const midBlock = renderedItems[149];
      const midBlockId = midBlock?.getAttribute('data-block-id');
      if (midBlockId) {
        blockListRef.current?.focusBlock(midBlockId);
      }
      const focusedId = document.activeElement?.getAttribute('data-block-id');

      return {
        renderedCount,
        summaryTotalText,
        typesMap,
        firstOrder,
        lastOrder,
        visibleCount: visibleIds.length,
        midBlockId,
        focusedId,
      };
    });

    assert.strictEqual(totalBlocksCount, 347, 'Real longform sample must split into exactly 347 blocks');
    assert.strictEqual(longformTest.renderedCount, 347, 'All 347 blocks must be continuously rendered in the DOM');
    assert.strictEqual(longformTest.summaryTotalText, '共 347 块', 'Summary bar must state "共 347 块"');
    assert.strictEqual(longformTest.firstOrder, '1', 'First block must have order 1');
    assert.strictEqual(longformTest.lastOrder, '347', 'Last block must have order 347');
    assert(longformTest.typesMap['table'] >= 18, 'Must render at least 18 table blocks');
    assert(longformTest.typesMap['image'] >= 6, 'Must render at least 6 image blocks');
    assert(longformTest.typesMap['paragraph'] >= 300, 'Must render paragraphs');
    assert(longformTest.visibleCount > 0, 'queryVisible must report visible blocks');
    assert.strictEqual(longformTest.focusedId, longformTest.midBlockId, 'focusBlock must successfully focus block #150');

    console.log(`✓ Test 5 Passed: 347-block real article rendered continuously in full, ref API tested on block #150`);

    console.log('\n==> All Issue #24 acceptance criteria verified successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
