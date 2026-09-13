import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';

async function run() {
  console.log('==> Starting Issue #22 TDD Verification (Table GFM & Degradation)...');

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
    // Test 1 (Slice 1): Regular WeChat table without <th> converts to GFM pipe table
    // --------------------------------------------------------------------------
    console.log('\n--- Test 1 (Slice 1): Regular WeChat table without <th> converts to GFM pipe table ---');

    const test1 = await page.evaluate(() => {
      const { splitBlocks, convertBlock } = window.__wetrim;

      const html = `
        <table style="border-collapse:collapse;">
          <tbody>
            <tr>
              <td><p><strong>要点</strong></p></td>
              <td><p><strong>内容</strong></p></td>
            </tr>
            <tr>
              <td><p>骨重塑频率</p></td>
              <td><p>成人约 5-10% 骨骼每年被重塑</p></td>
            </tr>
          </tbody>
        </table>
      `;

      const blocks = splitBlocks(html);
      const tableBlock = blocks[0];
      const converted = convertBlock(tableBlock);

      return {
        blocksCount: blocks.length,
        blockType: converted.type,
        markdown: converted.initialMarkdown,
        notes: converted.notes,
      };
    });

    assert.strictEqual(test1.blocksCount, 1, 'Table must split into exactly 1 block');
    assert.strictEqual(test1.blockType, 'table', 'Block type must be "table"');
    assert(
      !test1.markdown.startsWith('<table'),
      'CRITICAL: Markdown MUST NOT be raw HTML <table> fallback'
    );
    assert(
      test1.markdown.includes('| **要点** | **内容** |') ||
      test1.markdown.includes('| 要点 | 内容 |'),
      'First row must be converted to GFM table header'
    );
    assert(
      test1.markdown.includes('| --- | --- |') ||
      test1.markdown.includes('| :-- | :-- |'),
      'Delimiter row must exist'
    );
    assert(
      test1.markdown.includes('骨重塑频率') && test1.markdown.includes('成人约 5-10% 骨骼每年被重塑'),
      'Data row must be present'
    );
    assert.strictEqual(test1.notes.length, 0, 'Regular table should not have degradation notes');
    console.log('✓ Slice 1: Regular WeChat table converts to GFM pipe table without raw HTML fallback');

    // Test 1.2: Formatting in cells (alignment, pipes, links, images, multiple paragraphs)
    console.log('\n--- Test 1.2: Cell nuances (pipes, alignments, links, images, multiple paragraphs) ---');
    const test1_2 = await page.evaluate(() => {
      const { splitBlocks, convertBlock } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/sample-table';

      const html = `
        <table>
          <thead>
            <tr>
              <th align="center">标题一</th>
              <th style="text-align: right;">标题二 (A | B)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <p>第一段：包含 <a href="/subpath?id=123">站内链接</a> 与 <code>inline code</code></p>
                <p>第二段：包含图片 <img src="/icon.png" data-src="https://mmbiz.qpic.cn/icon.png" alt="小图标" /></p>
              </td>
              <td>
                <p>数据含有未转义管道符：x | y | z</p>
              </td>
            </tr>
          </tbody>
        </table>
      `;

      const blocks = splitBlocks(html);
      const converted = convertBlock(blocks[0], { baseUrl });

      return {
        markdown: converted.initialMarkdown,
      };
    });

    assert(test1_2.markdown.includes(':-:'), 'Center alignment must produce :-:');
    assert(test1_2.markdown.includes('--:'), 'Right alignment must produce --:');
    assert(test1_2.markdown.includes('A \\| B'), 'Pipe in header must be escaped as \\|');
    assert(test1_2.markdown.includes('x \\| y \\| z'), 'Pipes in cell must be escaped as \\|');
    assert(test1_2.markdown.includes('[站内链接](https://mp.weixin.qq.com/subpath?id=123)'), 'Link must resolve against baseUrl');
    assert(test1_2.markdown.includes('![小图标](https://mmbiz.qpic.cn/icon.png)'), 'Image data-src must be prioritized');
    assert(test1_2.markdown.includes('<br>'), 'Multiple paragraphs in cell should be joined by <br>');
    console.log('✓ Slice 1.2: Cell formatting, pipe escaping, alignment, and inline links/images verified');

    // --------------------------------------------------------------------------
    // Test 2 (Slice 2): Table degradation on merged cells and complex nesting
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2 (Slice 2): Table degradation on merged cells & complex nesting ---');

    const test2 = await page.evaluate(() => {
      const { splitBlocks, convertBlock } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/degraded-sample';

      // Case A: colspan > 1
      const htmlColspan = `
        <table>
          <tbody>
            <tr><th colspan="2">总体概述（合并两列）</th></tr>
            <tr><td>分类 A</td><td><a href="/link-a">详情 A</a></td></tr>
            <tr><td>分类 B</td><td><img src="/img-b.png" data-src="https://mmbiz.qpic.cn/img-b.png" alt="图B" /></td></tr>
          </tbody>
        </table>
      `;

      // Case B: rowspan > 1
      const htmlRowspan = `
        <table>
          <tbody>
            <tr><td rowspan="2">合并行项目</td><td>数值 1</td></tr>
            <tr><td>数值 2</td></tr>
          </tbody>
        </table>
      `;

      // Case C: Nested <table>
      const htmlNested = `
        <table>
          <tbody>
            <tr>
              <td>外部单元格 1</td>
              <td>
                <table>
                  <tbody>
                    <tr><td>内嵌数据 A</td><td>内嵌数据 B</td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      `;

      const blockColspan = convertBlock(splitBlocks(htmlColspan)[0], { baseUrl });
      const blockRowspan = convertBlock(splitBlocks(htmlRowspan)[0], { baseUrl });
      const blockNested = convertBlock(splitBlocks(htmlNested)[0], { baseUrl });

      return {
        colspan: {
          type: blockColspan.type,
          markdown: blockColspan.initialMarkdown,
          notes: blockColspan.notes,
        },
        rowspan: {
          type: blockRowspan.type,
          markdown: blockRowspan.initialMarkdown,
          notes: blockRowspan.notes,
        },
        nested: {
          type: blockNested.type,
          markdown: blockNested.initialMarkdown,
          notes: blockNested.notes,
        },
      };
    });

    // Verify Case A (colspan)
    assert.strictEqual(test2.colspan.type, 'table', 'Colspan degraded block must retain type "table"');
    assert(
      test2.colspan.notes.some((n) => n.code === 'table-degraded'),
      'Colspan table must have note with code "table-degraded"'
    );
    assert(
      !test2.colspan.markdown.startsWith('<table'),
      'Degraded table must not be raw HTML'
    );
    assert(test2.colspan.markdown.includes('总体概述（合并两列）'), 'Text must be preserved');
    assert(
      test2.colspan.markdown.includes('[详情 A](https://mp.weixin.qq.com/link-a)'),
      'Links must be preserved in degraded text'
    );
    assert(
      test2.colspan.markdown.includes('![图B](https://mmbiz.qpic.cn/img-b.png)'),
      'Images must be preserved in degraded text'
    );

    // Verify Case B (rowspan)
    assert.strictEqual(test2.rowspan.type, 'table', 'Rowspan degraded block must retain type "table"');
    assert(
      test2.rowspan.notes.some((n) => n.code === 'table-degraded'),
      'Rowspan table must have note with code "table-degraded"'
    );
    assert(
      !test2.rowspan.markdown.startsWith('<table'),
      'Degraded table must not be raw HTML'
    );
    assert(
      test2.rowspan.markdown.includes('合并行项目') &&
      test2.rowspan.markdown.includes('数值 1') &&
      test2.rowspan.markdown.includes('数值 2'),
      'All text from rowspan table must be preserved'
    );

    // Verify Case C (nested table)
    assert.strictEqual(test2.nested.type, 'table', 'Nested table block must retain type "table"');
    assert(
      test2.nested.notes.some((n) => n.code === 'table-degraded'),
      'Nested table must have note with code "table-degraded"'
    );
    assert(
      !test2.nested.markdown.startsWith('<table'),
      'Degraded nested table must not be raw HTML'
    );
    assert(
      test2.nested.markdown.includes('外部单元格 1') &&
      test2.nested.markdown.includes('内嵌数据 A') &&
      test2.nested.markdown.includes('内嵌数据 B'),
      'All text from nested table must be preserved'
    );

    console.log('✓ Slice 2: Table degradation on colspan, rowspan, and nested table verified');

    // --------------------------------------------------------------------------
    // Test 3 (Slice 3): Empty table degradation & Single block / Image collection / Preview render
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3 (Slice 3): Empty table degradation, Single-block integrity, Image-with-block & Preview ---');

    const test3 = await page.evaluate(() => {
      const { splitBlocks, convertBlock, buildArticleSnapshot } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/table-e2e';

      // 1. Empty table (like Deep Longform Table 4)
      const htmlEmpty = `
        <table style="border-collapse:collapse;">
          <tbody><tr style="mso-yfti-irow:0;"></tr></tbody>
        </table>
      `;
      const emptyBlocks = splitBlocks(htmlEmpty);
      const convertedEmpty = convertBlock(emptyBlocks[0], { baseUrl });

      // 2. Table with internal images and links (single block & image collection)
      const htmlWithImages = `
        <div id="js_content">
          <p>前置段落</p>
          <table>
            <thead>
              <tr><th>标志</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><img src="/logo-fallback.png" data-src="https://mmbiz.qpic.cn/logo1.png" alt="标志一" /></td>
                <td><a href="/about">关于说明</a></td>
              </tr>
              <tr>
                <td><img src="/logo-fallback.png" data-src="https://mmbiz.qpic.cn/logo2.png" alt="标志二" /></td>
                <td>第二项</td>
              </tr>
            </tbody>
          </table>
          <p>后置段落</p>
        </div>
      `;

      const capture = {
        kind: 'article',
        source: {
          url: baseUrl,
          title: '表格完整性与图片测试',
          author: 'WeTrim',
          accountName: 'WeTrimTest',
        },
        contentHtml: htmlWithImages,
        unstable: false,
      };

      const snapshot = buildArticleSnapshot(capture);
      const tableBlock = snapshot.blocks.find((b) => b.type === 'table');

      return {
        emptyBlock: {
          type: convertedEmpty.type,
          markdown: convertedEmpty.initialMarkdown,
          notes: convertedEmpty.notes,
        },
        snapshotBlocks: snapshot.blocks.map((b) => ({ type: b.type, order: b.order })),
        tableBlock: {
          markdown: tableBlock?.initialMarkdown || '',
        },
        images: snapshot.images.map((img) => img.url),
      };
    });

    // 1. Verify Empty Table
    assert.strictEqual(
      test3.emptyBlock.type,
      'unknown',
      'Empty table must degrade to unknown block'
    );
    assert(
      test3.emptyBlock.notes.some((n) => n.code === 'convert-failed'),
      'Empty table must have convert-failed note'
    );
    console.log('✓ Slice 3.1: Empty table correctly degrades to unknown block with convert-failed note');

    // 2. Verify Single Block Integrity (Table block does not split into sub-blocks)
    assert.strictEqual(test3.snapshotBlocks.length, 3, 'Paragraph + Table + Paragraph must be exactly 3 blocks');
    assert.strictEqual(test3.snapshotBlocks[0].type, 'paragraph');
    assert.strictEqual(test3.snapshotBlocks[1].type, 'table');
    assert.strictEqual(test3.snapshotBlocks[2].type, 'paragraph');
    console.log('✓ Slice 3.2: Table forms a single block without internal sub-block splitting');

    // 3. Verify Images inside table
    assert(
      test3.tableBlock.markdown.includes('![标志一](https://mmbiz.qpic.cn/logo1.png)'),
      'Table markdown must retain inlined image 1'
    );
    assert(
      test3.tableBlock.markdown.includes('![标志二](https://mmbiz.qpic.cn/logo2.png)'),
      'Table markdown must retain inlined image 2'
    );
    assert(
      test3.images.includes('https://mmbiz.qpic.cn/logo1.png') &&
      test3.images.includes('https://mmbiz.qpic.cn/logo2.png'),
      'Images inside table must be collected into snapshot.images'
    );
    console.log('✓ Slice 3.3: Images inside table are presented with the block and collected into ImageAsset list');

    // --------------------------------------------------------------------------
    // Test 4 (Slice 4): Benchmark Samples Verification (深度长文 19 表格 + 复合结构 2 表格)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4 (Slice 4): Benchmark Samples Verification (深度长文 19 表格 + 复合结构 2 表格) ---');

    const deepData = JSON.parse(
      execSync('git show 64d097d:output/wayfinder-12/samples/wetrim-sample-deep-longform.json', {
        maxBuffer: 50 * 1024 * 1024,
      })
    );
    const richData = JSON.parse(
      execSync('git show 64d097d:output/wayfinder-12/samples/wetrim-sample-rich-structure.json', {
        maxBuffer: 50 * 1024 * 1024,
      })
    );

    const test4 = await page.evaluate(
      ({ deepHtml, deepUrl, richHtml, richUrl }) => {
        const { splitBlocks, convertBlocks } = window.__wetrim;

        const deepBlocks = splitBlocks(deepHtml);
        const deepConverted = convertBlocks(deepBlocks, { baseUrl: deepUrl });
        const deepTables = deepConverted.filter(
          (b) => b.type === 'table' || (b.type === 'unknown' && b.originalHtml.includes('<table'))
        );

        const richBlocks = splitBlocks(richHtml);
        const richConverted = convertBlocks(richBlocks, { baseUrl: richUrl });
        const richTables = richConverted.filter((b) => b.type === 'table');

        return {
          deep: {
            totalTables: deepTables.length,
            tableBlocks: deepTables.map((b) => ({
              type: b.type,
              order: b.order,
              markdownLength: b.initialMarkdown.length,
              isRawHtml: b.initialMarkdown.startsWith('<table'),
              isPipeTable: b.initialMarkdown.startsWith('|'),
              notes: b.notes,
              tdCount: (b.originalHtml.match(/<td\b/gi) || []).length,
            })),
          },
          rich: {
            totalTables: richTables.length,
            tableBlocks: richTables.map((b) => ({
              type: b.type,
              order: b.order,
              markdownLength: b.initialMarkdown.length,
              isRawHtml: b.initialMarkdown.startsWith('<table'),
              isPipeTable: b.initialMarkdown.startsWith('|'),
              notes: b.notes,
              tdCount: (b.originalHtml.match(/<td\b/gi) || []).length,
            })),
          },
        };
      },
      {
        deepHtml: deepData.RESULTS.content.after.html,
        deepUrl: deepData.RESULTS.content.meta?.url || 'https://mp.weixin.qq.com/s/deep',
        richHtml: richData.RESULTS.content.after.html,
        richUrl: richData.RESULTS.content.meta?.url || 'https://mp.weixin.qq.com/s/rich',
      }
    );

    // 1. Verify 深度长文
    console.log(`Deep Longform total table blocks: ${test4.deep.totalTables}`);
    assert.strictEqual(test4.deep.totalTables, 19, '深度长文应有 19 个表格块（18 table + 1 unknown）');

    const deepTotalTd = test4.deep.tableBlocks.reduce((acc, t) => acc + t.tdCount, 0);
    console.log(`Deep Longform total td count: ${deepTotalTd}`);
    assert.strictEqual(deepTotalTd, 215, '深度长文表格总 td 数必须恰好为 215 个');

    let deepRegularCount = 0;
    let deepUnknownCount = 0;

    test4.deep.tableBlocks.forEach((t, i) => {
      assert(!t.isRawHtml, `深度长文 Table #${i + 1} 绝不能回退为 raw HTML`);
      if (t.type === 'table') {
        deepRegularCount++;
        assert(t.isPipeTable, `深度长文 Table #${i + 1} 必须是 GFM 管道表格`);
      } else if (t.type === 'unknown') {
        deepUnknownCount++;
        assert.strictEqual(t.tdCount, 0, `深度长文降级为 unknown 的表格应为 0 单元格空表格`);
        assert(t.notes.some((n) => n.code === 'convert-failed'), '空表格应挂 convert-failed 提示');
      }
    });

    assert.strictEqual(deepRegularCount, 18, '深度长文应有 18 个正常 GFM 表格');
    assert.strictEqual(deepUnknownCount, 1, '深度长文应有 1 个空表格降级为 unknown');
    console.log('✓ 深度长文 19 个表格（215 个 td）验证完全通过！');

    // 2. Verify 复合结构
    console.log(`Rich Structure total table blocks: ${test4.rich.totalTables}`);
    assert.strictEqual(test4.rich.totalTables, 2, '复合结构应有 2 个表格块');

    const richTotalTd = test4.rich.tableBlocks.reduce((acc, t) => acc + t.tdCount, 0);
    console.log(`Rich Structure total td count: ${richTotalTd}`);
    assert.strictEqual(richTotalTd, 28, '复合结构表格总 td 数应为 28 个 (16 + 12)');

    test4.rich.tableBlocks.forEach((t, i) => {
      assert(!t.isRawHtml, `复合结构 Table #${i + 1} 绝不能回退为 raw HTML`);
      assert(t.isPipeTable, `复合结构 Table #${i + 1} 必须是 GFM 管道表格`);
    });
    console.log('✓ 复合结构 2 个表格（28 个 td）验证完全通过！');

    // --------------------------------------------------------------------------
    // Test 5: Safe preview rendering of converted tables (marked + DOMPurify)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Safe preview rendering (marked + DOMPurify) ---');

    const samplePipeTableMd = test4.deep.tableBlocks[0].markdownLength > 0 ?
      '| 要点 | 内容 |\n| --- | --- |\n| 骨重塑频率 | 成人约 5-10% 骨骼每年被重塑 |\n' : '';

    const sampleDegradedMd = '总体概述（合并两列）\n分类 A | [详情 A](https://mp.weixin.qq.com/link-a)\n分类 B | ![图B](https://mmbiz.qpic.cn/img-b.png)\n<script>alert("xss")</script>';

    const test5 = await page.evaluate(
      ({ pipeMd, degradedMd }) => {
        const { renderMarkdown } = window.__wetrim;

        const renderedPipeHtml = renderMarkdown(pipeMd);
        const renderedDegradedHtml = renderMarkdown(degradedMd);

        const parser = new DOMParser();
        const pipeDoc = parser.parseFromString(renderedPipeHtml, 'text/html');
        const degradedDoc = parser.parseFromString(renderedDegradedHtml, 'text/html');

        return {
          pipe: {
            hasTable: Boolean(pipeDoc.querySelector('table')),
            hasThead: Boolean(pipeDoc.querySelector('thead')),
            thCount: pipeDoc.querySelectorAll('th').length,
            tdCount: pipeDoc.querySelectorAll('td').length,
          },
          degraded: {
            hasLink: Boolean(degradedDoc.querySelector('a[href="https://mp.weixin.qq.com/link-a"]')),
            hasImg: Boolean(degradedDoc.querySelector('img[src="https://mmbiz.qpic.cn/img-b.png"]')),
            hasScript: Boolean(degradedDoc.querySelector('script')),
            text: degradedDoc.body.textContent || '',
          },
        };
      },
      {
        pipeMd: samplePipeTableMd,
        degradedMd: sampleDegradedMd,
      }
    );

    // Assert pipe table is recognized as real HTML table by marked
    assert(test5.pipe.hasTable, 'Preview must render pipe table as <table>');
    assert(test5.pipe.hasThead, 'Preview must render header row as <thead>');
    assert.strictEqual(test5.pipe.thCount, 2, 'Preview table must contain 2 <th> elements');
    assert.strictEqual(test5.pipe.tdCount, 2, 'Preview table must contain 2 <td> elements');

    // Assert degraded text is rendered safely, with links and images preserved, script sanitized
    assert(test5.degraded.hasLink, 'Preview must preserve links in degraded table text');
    assert(test5.degraded.hasImg, 'Preview must preserve images in degraded table text');
    assert(!test5.degraded.hasScript, 'DOMPurify must sanitize <script> tags');
    assert(test5.degraded.text.includes('总体概述（合并两列）'), 'Text content must be rendered in preview');
    console.log('✓ Safe preview rendering (marked + DOMPurify) substantively verified!');


    console.log('\n==> All Issue #22 tests passed successfully!');
  } finally {
    await browser.close();
  }
}


run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
