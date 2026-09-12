import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';

async function run() {
  console.log('==> Starting Issue #20 comprehensive verification (Lists and Nested Encodings)...');

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
    await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 1: 有序与无序完全同构与基础转换
    // --------------------------------------------------------------------------
    console.log('\n--- Test 1: Ordered and unordered list isomorphism & basic conversion ---');

    const test1 = await page.evaluate(() => {
      const { createTurndown } = window.__wetrim;
      const td = createTurndown();

      // 无序列表（真实样式 class="list-paddingleft-1"）
      const htmlUl = `
        <ul class="list-paddingleft-1">
          <li><p style="text-align: justify;"><span leaf="">无序项目一</span></p></li>
          <li><p style="text-align: justify;"><span leaf="">无序项目二</span></p></li>
        </ul>
      `;
      const mdUl = td.turndown(htmlUl).trim();

      // 有序列表（真实样式 class="list-paddingleft-1" style="list-style-type: decimal;"）
      const htmlOl = `
        <ol class="list-paddingleft-1" style="list-style-type: decimal;">
          <li><p style="text-align: justify;"><span leaf="">有序项目一</span></p></li>
          <li><p style="text-align: justify;"><span leaf="">有序项目二</span></p></li>
        </ol>
      `;
      const mdOl = td.turndown(htmlOl).trim();

      return { mdUl, mdOl };
    });

    assert.strictEqual(test1.mdUl, '-   无序项目一\n-   无序项目二', 'Unordered list must use - marker without blank lines');
    assert.strictEqual(test1.mdOl, '1.  有序项目一\n2.  有序项目二', 'Ordered list must start from 1 with . marker without blank lines');
    console.log('✓ Unordered and ordered lists converted isomorphically with clean markers and zero redundant blank lines');

    // --------------------------------------------------------------------------
    // Test 2: <li> 里包着 <p> 的行内处理与多段落支持
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: <li> containing <p> inline handling & multi-paragraph items ---');

    const test2 = await page.evaluate(() => {
      const { createTurndown } = window.__wetrim;
      const td = createTurndown();

      // 单段落：- / 1. 紧接行内内容，不产生多余空行，行内格式保留
      const htmlSingleP = `
        <ul class="list-paddingleft-1">
          <li><p style="margin: 0;"><strong>粗体标题：</strong><span leaf="">正文与</span> <code>inline_code</code> 和 <a href="https://example.com">链接</a></p></li>
          <li><p style="margin: 0;"><em>斜体项目</em></p></li>
        </ul>
      `;
      const mdSingleP = td.turndown(htmlSingleP).trim();

      // 多段落：同个 li 内多个 p，段落间正常保留空行，但 li 间不插入多余空行破坏列表
      const htmlMultiP = `
        <ul>
          <li>
            <p>第一项 第一段</p>
            <p>第一项 第二段</p>
          </li>
          <li>
            <p>第二项 单段</p>
          </li>
        </ul>
      `;
      const mdMultiP = td.turndown(htmlMultiP).trim();

      return { mdSingleP, mdMultiP };
    });

    assert(test2.mdSingleP.includes('**粗体标题：**'), 'Bold in li > p must be preserved');
    assert(test2.mdSingleP.includes('`inline_code`'), 'Inline code in li > p must be preserved');
    assert(test2.mdSingleP.includes('[链接](https://example.com)'), 'Link in li > p must be preserved');
    assert(test2.mdSingleP.includes('*斜体项目*') || test2.mdSingleP.includes('_斜体项目_'), 'Emphasis in li > p must be preserved');
    assert(!test2.mdSingleP.includes('\n\n-'), 'No blank lines between single-paragraph list items');


    assert(test2.mdMultiP.includes('第一项 第一段\n    \n    第一项 第二段'), 'Multiple paragraphs within an item must be indented and spaced');
    assert(test2.mdMultiP.includes('\n-   第二项 单段'), 'Next list item must follow immediately without loose-list blank line');
    console.log('✓ <li> wrapping <p> correctly treats first p as inline content, preserves inner formatting, and supports multi-p');

    // --------------------------------------------------------------------------
    // Test 3: 尊重 start 属性
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Respecting start attribute on <ol> ---');

    const test3 = await page.evaluate(() => {
      const { createTurndown } = window.__wetrim;
      const td = createTurndown();

      const htmlStart3 = `
        <ol start="3">
          <li><p>第三项</p></li>
          <li><p>第四项</p></li>
        </ol>
      `;
      const mdStart3 = td.turndown(htmlStart3).trim();

      const htmlStart10 = `
        <ol start="10">
          <li><p>第十项</p></li>
        </ol>
      `;
      const mdStart10 = td.turndown(htmlStart10).trim();

      const htmlNoStart = `
        <ol>
          <li><p>第一项</p></li>
        </ol>
      `;
      const mdNoStart = td.turndown(htmlNoStart).trim();

      return { mdStart3, mdStart10, mdNoStart };
    });

    assert.strictEqual(test3.mdStart3, '3.  第三项\n4.  第四项', 'ol with start="3" must start numbering at 3');
    assert.strictEqual(test3.mdStart10, '10.  第十项', 'ol with start="10" must start numbering at 10');
    assert.strictEqual(test3.mdNoStart, '1.  第一项', 'ol without start must start numbering at 1');
    console.log('✓ start attribute respected on ordered lists (start=3, start=10, default=1)');

    // --------------------------------------------------------------------------
    // Test 4: 代码块行号 <ul> 排除验证
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Code snippet line-number <ul> excluded from content lists ---');

    const listJson = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/wetrim-struct-list.json'));

    const test4 = await page.evaluate(({ articleHtml }) => {
      const { splitBlocks } = window.__wetrim;
      const blocks = splitBlocks(articleHtml);

      // 统计所有被切成 list 块的数量
      const listBlocks = blocks.filter((b) => b.type === 'list');
      // 统计所有代码块的数量
      const codeBlocks = blocks.filter((b) => b.type === 'code');

      // 检查是否有任何 list 块包含 code-snippet__line-index
      const leakedLineIndexLists = listBlocks.filter((b) =>
        b.originalHtml.includes('code-snippet__line-index')
      );

      return {
        totalBlocks: blocks.length,
        listBlockCount: listBlocks.length,
        codeBlockCount: codeBlocks.length,
        leakedLineIndexCount: leakedLineIndexLists.length,
      };
    }, { articleHtml: listJson.RESULTS.content.after.html });

    assert.strictEqual(test4.codeBlockCount, 7, 'wetrim-struct-list.json must have 7 code blocks');
    assert.strictEqual(test4.listBlockCount, 8, 'wetrim-struct-list.json must have exactly 8 content list blocks');
    assert.strictEqual(test4.leakedLineIndexCount, 0, 'No code-snippet line index may leak as list block');

    // 验证 HIGH-1：列表项内包含代码块时，行号 <ul> 不被 wechatSubList 误拦截
    const codeInsideLiResult = await page.evaluate(() => {
      const { createTurndown } = window.__wetrim;
      const td = createTurndown();
      const html = `
        <ul>
          <li>
            <p>列表项代码演示：</p>
            <section class="code-snippet__fix code-snippet__js">
              <ul class="code-snippet__line-index code-snippet__js"><li></li><li></li></ul>
              <pre class="code-snippet__js" data-lang="javascript">
                <code>const a = 1;</code>
                <code>console.log(a);</code>
              </pre>
            </section>
          </li>
        </ul>
      `;
      return td.turndown(html).trim();
    });

    assert(codeInsideLiResult.includes('```javascript'), 'Code block inside li must render language fence');
    assert(codeInsideLiResult.includes('const a = 1;') && codeInsideLiResult.includes('console.log(a);'), 'Code block inside li must retain code lines');
    assert(!codeInsideLiResult.includes('-   \n') && !codeInsideLiResult.includes('1.  \n'), 'Line numbers must not leak into list');
    console.log('✓ 7 code snippet line-number <ul> containers strictly excluded, and code snippet inside <li> does not leak line index');


    // --------------------------------------------------------------------------
    // Test 5: 假设 A（真嵌套 <ul><li><ul>）切块与转换验证
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Assumption A (true nesting <ul><li><ul>) ---');

    const trueJson = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/_fixture-nested-true.json'));

    const test5 = await page.evaluate(({ articleHtml }) => {
      const { splitBlocks, convertBlocks } = window.__wetrim;
      const blocks = splitBlocks(articleHtml);
      const converted = convertBlocks(blocks);

      const listBlocks = converted.filter((b) => b.type === 'list');
      const listMd = listBlocks[0]?.initialMarkdown || '';

      return {
        totalBlocks: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        listBlockCount: listBlocks.length,
        listMd,
      };
    }, { articleHtml: trueJson.RESULTS.content.after.html });

    assert.strictEqual(test5.totalBlocks, 3, 'Assumption A fixture must produce exactly 3 blocks (paragraph, list, paragraph)');
    assert.deepStrictEqual(test5.blockTypes, ['paragraph', 'list', 'paragraph'], 'Blocks must be [paragraph, list, paragraph]');
    assert.strictEqual(test5.listBlockCount, 1, 'All 3 levels must be contained in 1 list block per ADR-0001');

    const expectedNestedMd =
      '-   一级项 A\n' +
      '-   一级项 B\n' +
      '    -   二级项 B1\n' +
      '    -   二级项 B2\n' +
      '        1.  三级项 B2a\n' +
      '-   一级项 C';

    assert.strictEqual(test5.listMd, expectedNestedMd, 'Assumption A Markdown must match expected 3-level hierarchy');
    assert(!test5.listMd.includes('\n\n'), 'Assumption A list Markdown must not contain redundant blank lines');
    console.log('✓ Assumption A (true nesting): 3-level list is 1 block, converts to tight Markdown');

    // --------------------------------------------------------------------------
    // Test 6: 假设 B（平铺兄弟 + list-paddingleft-N）切块前合并与转换验证
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Assumption B (flat siblings + list-paddingleft-N) ---');

    const flatJson = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/_fixture-nested-flat.json'));

    const test6 = await page.evaluate(({ articleHtml }) => {
      const { splitBlocks, convertBlocks } = window.__wetrim;
      const blocks = splitBlocks(articleHtml);
      const converted = convertBlocks(blocks);

      const listBlocks = converted.filter((b) => b.type === 'list');
      const listMd = listBlocks[0]?.initialMarkdown || '';

      return {
        totalBlocks: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        listBlockCount: listBlocks.length,
        listMd,
      };
    }, { articleHtml: flatJson.RESULTS.content.after.html });

    assert.strictEqual(test6.totalBlocks, 3, 'Assumption B fixture must produce exactly 3 blocks (merged into 1 list block)');
    assert.deepStrictEqual(test6.blockTypes, ['paragraph', 'list', 'paragraph'], 'Blocks must be [paragraph, list, paragraph]');
    assert.strictEqual(test6.listBlockCount, 1, 'Flat sibling lists must be merged into 1 list block per ADR-0001');

    assert.strictEqual(test6.listMd, expectedNestedMd, 'Assumption B Markdown must match Assumption A Markdown exactly');
    assert(!test6.listMd.includes('\n\n'), 'Assumption B list Markdown must not contain redundant blank lines');
    console.log('✓ Assumption B (flat siblings): merged before splitting, 3-level list is 1 block, converts identical to Assumption A');

    // --------------------------------------------------------------------------
    // Test 7: 固有降级与非相邻列表隔离验证
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Inherent degradation & non-adjacent list separation ---');

    const test7 = await page.evaluate(() => {
      const { splitBlocks, convertBlocks } = window.__wetrim;

      // 7.1 固有降级：两段独立的一级列表，中间无其它内容，平铺编码下在 DOM 里无法区分，合并为 1 个列表块
      const htmlAdjacentLevel1 = `
        <div id="js_content">
          <ul class="list-paddingleft-1">
            <li><p>列表一 项目 A</p></li>
          </ul>
          <ul class="list-paddingleft-1">
            <li><p>列表二 项目 B</p></li>
          </ul>
        </div>
      `;
      const blocksAdj = splitBlocks(htmlAdjacentLevel1);

      // 7.2 非相邻列表：两段列表之间夹有正文段落，必须各自独立成块，不得误合并
      const htmlSeparated = `
        <div id="js_content">
          <ul class="list-paddingleft-1">
            <li><p>独立列表一</p></li>
          </ul>
          <p>中间的正文内容</p>
          <ul class="list-paddingleft-1">
            <li><p>独立列表二</p></li>
          </ul>
        </div>
      `;
      const blocksSep = splitBlocks(htmlSeparated);

      return {
        adjCount: blocksAdj.length,
        adjType: blocksAdj[0]?.type,
        sepCount: blocksSep.length,
        sepTypes: blocksSep.map((b) => b.type),
      };
    });

    assert.strictEqual(test7.adjCount, 1, 'Inherent degradation: contiguous level-1 lists with no content in between merge into 1 block');
    assert.strictEqual(test7.adjType, 'list');
    console.log('✓ Inherent degradation verified: contiguous level-1 lists without content merge into 1 block');

    assert.strictEqual(test7.sepCount, 3, 'Lists separated by text paragraph must not merge');
    assert.deepStrictEqual(test7.sepTypes, ['list', 'paragraph', 'list'], 'Separated lists must stay distinct blocks');
    console.log('✓ Lists separated by text paragraph correctly preserve separate blocks');

    // --------------------------------------------------------------------------
    // Test 8: 自检：全量真实基准样例列表块无多余空行，全量零回归
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: All 11 benchmarks article-wide list self-tests & zero regression ---');

    const sampleDescriptors = [
      { commit: '64d097d', path: 'output/wayfinder-12/samples/wetrim-sample-deep-longform.json', name: '深度长文' },
      { commit: '64d097d', path: 'output/wayfinder-12/samples/wetrim-sample-photo-heavy.json', name: '图集' },
      { commit: '64d097d', path: 'output/wayfinder-12/samples/wetrim-sample-rich-structure.json', name: '复合结构' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/wetrim-struct-code.json', name: '结构-代码' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/wetrim-struct-list.json', name: '结构-长列表' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/wetrim-struct-quote-list.json', name: '结构-引用列表' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/wetrim-struct-rich-misc.json', name: '结构-富媒体' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/_fixture-constructed.json', name: '夹具-构造复合' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/_fixture-nested-flat.json', name: '夹具-浅嵌套' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/_fixture-nested-true.json', name: '夹具-真嵌套' },
      { commit: 'd923f48', path: 'output/wayfinder-13/samples/_fixture-quote-list.json', name: '夹具-引用列表' },
    ];

    let totalListBlocks = 0;
    let totalBlocks = 0;

    for (const item of sampleDescriptors) {
      const rawJson = execSync(`git show ${item.commit}:${item.path}`, { maxBuffer: 50 * 1024 * 1024 }).toString();
      const data = JSON.parse(rawJson);
      const html = data.RESULTS?.content?.after?.html || '';

      const res = await page.evaluate(({ articleHtml, label }) => {
        const { buildArticleSnapshot } = window.__wetrim;
        const snap = buildArticleSnapshot({
          kind: 'article',
          title: label,
          source: { url: 'https://mp.weixin.qq.com/s/benchmark', accountName: 'Test' },
          contentHtml: articleHtml,
          capturedAt: new Date().toISOString(),
        });

        // 自检：列表块的 Markdown 不含多余空行（针对单段落 li）
        const listBlocks = snap.blocks.filter((b) => b.type === 'list');
        const listBlocksWithExtraBlankLines = listBlocks.filter((b) => {
          // 列表项之间不应存在空行 \n\s*\n（多段落 li 内部空行除外，真实样例 12 个列表全部是单段落）
          return /\n\s*\n/.test(b.initialMarkdown.trim());
        });

        // 通用自检：非空 HTML 不转出空 Markdown
        const emptyMarkdownBlocks = snap.blocks.filter(
          (b) => Boolean(b.originalHtml?.trim()) && !Boolean(b.initialMarkdown?.trim())
        );

        // 通用自检：围栏代码块无 U+00A0
        const codeBlocks = snap.blocks.filter((b) => b.type === 'code');
        const u00a0Violations = codeBlocks.filter((b) => b.initialMarkdown.includes('\u00a0'));

        return {
          blockCount: snap.blocks.length,
          listBlockCount: listBlocks.length,
          extraBlankLinesCount: listBlocksWithExtraBlankLines.length,
          emptyMarkdownCount: emptyMarkdownBlocks.length,
          u00a0ViolationsCount: u00a0Violations.length,
        };
      }, { articleHtml: html, label: item.name });

      assert.strictEqual(
        res.extraBlankLinesCount,
        0,
        `Self-Test failed: ${item.name} has ${res.extraBlankLinesCount} list blocks with redundant blank lines`
      );
      assert.strictEqual(
        res.emptyMarkdownCount,
        0,
        `${item.name} has empty markdown blocks: ${res.emptyMarkdownCount}`
      );
      assert.strictEqual(
        res.u00a0ViolationsCount,
        0,
        `${item.name} has U+00A0 in code blocks`
      );

      totalListBlocks += res.listBlockCount;
      totalBlocks += res.blockCount;

      console.log(`  ✓ [${item.name}] ${res.blockCount} blocks (${res.listBlockCount} list blocks). 0 redundant blank lines. 0 empty MD.`);
    }

    console.log('\n======================================================');
    console.log(`✓ 11/11 Benchmark samples passed all Self-Tests!`);
    console.log(`✓ Total blocks checked: ${totalBlocks}, Total content list blocks: ${totalListBlocks}`);
    console.log(`✓ Self-Test: Zero redundant blank lines in all list blocks`);
    console.log(`✓ Assumption A and Assumption B fully tested and verified!`);
    console.log(`✓ All Issue #20 Acceptance Criteria Verified Successfully!`);
    console.log('======================================================');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
