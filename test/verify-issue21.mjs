import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import fs from 'fs';
import { execSync } from 'child_process';

async function run() {
  console.log('==> Starting Issue #21 comprehensive verification (Blockquote Conversion)...');

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
    // Test 1: 整段 blockquote 转成一个引用块，行内格式与链接保留
    // --------------------------------------------------------------------------
    console.log('\n--- Test 1: Single paragraph blockquote & inline formatting / links retention ---');

    const test1 = await page.evaluate(() => {
      const { splitBlocks, convertBlocks } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/test-quote';

      const html = `
        <blockquote class="js_blockquote_wrap">
          <p><span leaf="">引用重要原则：<strong>强调加粗</strong>、<em>斜体文字</em>、<code>const code = true;</code> 以及 <a href="/internal/path?tag=1&amp;ref=quote#sec">相对链接</a> 和 <a href="https://external.com/out?a=1&amp;b=2">外链</a>。</span></p>
        </blockquote>
      `;

      const blocks = splitBlocks(html);
      const converted = convertBlocks(blocks, { baseUrl });
      const quoteBlock = converted[0];

      return {
        blocksCount: blocks.length,
        blockType: quoteBlock?.type,
        markdown: quoteBlock?.initialMarkdown || '',
      };
    });

    assert.strictEqual(test1.blocksCount, 1, 'Single blockquote must be exactly 1 block');
    assert.strictEqual(test1.blockType, 'quote', 'Block type must be "quote"');
    assert(test1.markdown.startsWith('> '), 'Markdown must start with "> "');
    assert(test1.markdown.includes('**强调加粗**'), 'Bold formatting must be preserved inside quote');
    assert(test1.markdown.includes('*斜体文字*') || test1.markdown.includes('_斜体文字_'), 'Emphasis must be preserved inside quote');
    assert(test1.markdown.includes('`const code = true;`'), 'Inline code must be preserved inside quote');
    assert(
      test1.markdown.includes('[相对链接](https://mp.weixin.qq.com/internal/path?tag=1&ref=quote#sec)'),
      'Relative link must be resolved against baseUrl and retain parameters'
    );
    assert(
      test1.markdown.includes('[外链](https://external.com/out?a=1&b=2)'),
      'External link must retain all query parameters'
    );
    console.log('✓ Single blockquote converts to 1 quote block, with bold, italic, code, and links preserved');

    // --------------------------------------------------------------------------
    // Test 2: 五个真实引用全部通过验证（全部为单段落形态）
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Verification of all 5 real WeChat blockquotes from benchmark articles ---');

    const realQuote1 = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/wetrim-struct-quote-list.json'));
    const realQuote2 = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/wetrim-struct-list.json'));
    const realQuote3 = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/wetrim-struct-rich-misc.json'));

    const test2 = await page.evaluate(
      ({ q1Html, q2Html, q3Html }) => {
        const { splitBlocks, convertBlocks } = window.__wetrim;

        const convertArticleQuotes = (html, url) => {
          const blocks = splitBlocks(html);
          const converted = convertBlocks(blocks, { baseUrl: url });
          return converted.filter((b) => b.type === 'quote');
        };

        const quotes1 = convertArticleQuotes(q1Html, 'https://mp.weixin.qq.com/s/-y9Gqkckr1AJsuNReEKZYg');
        const quotes2 = convertArticleQuotes(q2Html, 'https://mp.weixin.qq.com/s/Vy2HpOyr7wVmPTVWa3mGig');
        const quotes3 = convertArticleQuotes(q3Html, 'https://mp.weixin.qq.com/s/nFgdzgL9kWXdYAfmu7gvPQ');

        return {
          q1Results: quotes1.map((q) => q.initialMarkdown),
          q2Results: quotes2.map((q) => q.initialMarkdown),
          q3Results: quotes3.map((q) => q.initialMarkdown),
        };
      },
      {
        q1Html: realQuote1.RESULTS.content.after.html,
        q2Html: realQuote2.RESULTS.content.after.html,
        q3Html: realQuote3.RESULTS.content.after.html,
      }
    );

    // Article 1: 3 quotes
    assert.strictEqual(test2.q1Results.length, 3, 'wetrim-struct-quote-list.json must have 3 quote blocks');
    assert.strictEqual(test2.q1Results[0], '> Part 1 · 演进：从一句话到一个系统', 'Real quote 1 match');
    assert.strictEqual(test2.q1Results[1], '> Part 2 · 拓扑：从串行循环到并行图谱', 'Real quote 2 match');
    assert.strictEqual(test2.q1Results[2], '> Part 3 · 落地：怎么用起来', 'Real quote 3 match');

    // Article 2: 1 quote
    assert.strictEqual(test2.q2Results.length, 1, 'wetrim-struct-list.json must have 1 quote block');
    assert.strictEqual(
      test2.q2Results[0],
      '> 建议：优先升级框架版本，避免引入额外的 Hook 组件。',
      'Real quote 4 match'
    );

    // Article 3: 1 quote (with link and <br>)
    assert.strictEqual(test2.q3Results.length, 1, 'wetrim-struct-rich-misc.json must have 1 quote block');
    assert(
      test2.q3Results[0].includes('本文是「[每周 Signal｜AI × SE]'),
      'Real quote 5 must contain link text'
    );
    assert(
      test2.q3Results[0].includes('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=Mzg4Mjg4NTAyMw=='),
      'Real quote 5 must contain link url'
    );
    assert(
      test2.q3Results[0].includes('> AI 开始获得代码合并审批权。'),
      'Real quote 5 second line after break must have > prefix'
    );
    console.log('✓ All 5 real WeChat blockquotes (3+1+1) verified across benchmark samples');

    // --------------------------------------------------------------------------
    // Test 3: 多段落引用整体成 1 个引用块，段落间的 > 前缀正确
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Multi-paragraph blockquote as 1 block & correct > prefix between paragraphs ---');

    const test3 = await page.evaluate(() => {
      const { splitBlocks, convertBlocks } = window.__wetrim;

      // 构造多段落引用（含 section 包装、多段落以及 <p><br></p> 占位）
      const multiParagraphHtml = `
        <div id="js_content">
          <p>正文引言段落</p>
          <blockquote class="js_blockquote_wrap">
            <section><p><span leaf="">第一段：系统架构分层设计原则。</span></p></section>
            <p><br></p>
            <section><p><span leaf="">第二段：数据流动与状态持久化机制。</span></p></section>
            <section><p><span leaf="">第三段：异常容灾与单块级降级路径。</span></p></section>
          </blockquote>
          <p>正文结语段落</p>
        </div>
      `;

      const blocks = splitBlocks(multiParagraphHtml);
      const converted = convertBlocks(blocks);

      const quoteBlock = blocks.find((b) => b.type === 'quote');
      const quoteConverted = converted.find((b) => b.type === 'quote');
      const quoteMd = quoteConverted?.initialMarkdown || '';
      const lines = quoteMd.split('\n');

      return {
        totalBlocks: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        quoteMd,
        lines,
        allLinesStartWithGreater: lines.every((line) => line.startsWith('>')),
      };
    });

    assert.strictEqual(test3.totalBlocks, 3, 'Article with multi-paragraph quote must have 3 blocks (paragraph, quote, paragraph)');
    assert.deepStrictEqual(test3.blockTypes, ['paragraph', 'quote', 'paragraph'], 'Blocks must be [paragraph, quote, paragraph]');
    assert.strictEqual(test3.allLinesStartWithGreater, true, 'Every line in multi-paragraph quote Markdown must start with ">"');

    // 断言段落间空行前缀正确（"> " 或 ">"），无丢失前缀的空行
    const expectedMultiMd =
      '> 第一段：系统架构分层设计原则。\n' +
      '> \n' +
      '> 第二段：数据流动与状态持久化机制。\n' +
      '> \n' +
      '> 第三段：异常容灾与单块级降级路径。';
    assert.strictEqual(test3.quoteMd, expectedMultiMd, 'Multi-paragraph quote must have clean > on blank lines');

    // 验证 Finding 1 修复：段落间包含多行纯空白时能被彻底折叠，不残留 > 悬挂空格
    const consecutiveWhitespaceResult = await page.evaluate(() => {
      const { createTurndown } = window.__wetrim;
      const td = createTurndown();
      const html = '<blockquote><p>前文</p>   \n   \n<p>后文</p></blockquote>';
      return td.turndown(html).trim();
    });
    assert.strictEqual(
      consecutiveWhitespaceResult,
      '> 前文\n> \n> 后文',
      'Consecutive whitespace lines between paragraphs must be folded cleanly'
    );

    // 验证 Finding 2 修复：纯空白/空引用块触发单块级降级保护为 unknown
    const emptyQuoteResult = await page.evaluate(() => {
      const { convertBlock } = window.__wetrim;
      const emptyBlock = {
        id: 'empty-quote-1',
        order: 1,
        type: 'quote',
        originalHtml: '<blockquote class="js_blockquote_wrap"><p><br></p></blockquote>',
        initialMarkdown: '',
        editedMarkdown: null,
        included: true,
        notes: [],
      };
      return convertBlock(emptyBlock);
    });
    assert.strictEqual(emptyQuoteResult.type, 'unknown', 'Empty blockquote must degrade to unknown block');
    assert(
      emptyQuoteResult.notes.some((n) => n.code === 'convert-failed'),
      'Empty blockquote must contain convert-failed note'
    );

    console.log('✓ Multi-paragraph blockquote is 1 block, with clean > prefix between paragraphs and no empty line leakage');
    console.log('✓ Finding 1 (consecutive whitespace folding) and Finding 2 (empty quote degradation) verified');

    // --------------------------------------------------------------------------
    // Test 4: 引用套列表整体成 1 个引用块（🔧 构造验证），内部列表在引用内正确缩进
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Quote wrapping list (wrench constructed) as 1 block with proper indent ---');

    const fixtureQuoteList = JSON.parse(execSync('git show d923f48:output/wayfinder-13/samples/_fixture-quote-list.json'));

    const test4 = await page.evaluate(({ fixtureHtml }) => {
      const { splitBlocks, convertBlocks } = window.__wetrim;

      // 4a. 验证标准夹具 _fixture-quote-list.json
      const blocks = splitBlocks(fixtureHtml);
      const converted = convertBlocks(blocks);
      const fixtureQuoteMd = converted.find((b) => b.type === 'quote')?.initialMarkdown || '';

      // 4b. 验证复杂引用套列表（包含二级嵌套子列表与有序列表）
      const complexQuoteListHtml = `
        <div id="js_content">
          <blockquote class="js_blockquote_wrap">
            <section><p><span leaf="">引言：清单如下：</span></p></section>
            <ul class="list-paddingleft-1">
              <li><p><span leaf="">一级条目 1</span></p></li>
              <li><p><span leaf="">一级条目 2</span></p>
                <ul class="list-paddingleft-2">
                  <li><p><span leaf="">二级嵌套子项 2.1</span></p></li>
                  <li><p><span leaf="">二级嵌套子项 2.2</span></p></li>
                </ul>
              </li>
            </ul>
            <ol class="list-paddingleft-1" style="list-style-type: decimal;">
              <li><p><span leaf="">第一步准备</span></p></li>
              <li><p><span leaf="">第二步执行</span></p></li>
            </ol>
            <section><p><span leaf="">结语：执行完毕。</span></p></section>
          </blockquote>
        </div>
      `;

      const complexBlocks = splitBlocks(complexQuoteListHtml);
      const complexConverted = convertBlocks(complexBlocks);
      const complexQuoteMd = complexConverted[0]?.initialMarkdown || '';

      // 4c. 验证假设 B：引用内部平铺兄弟列表（list-paddingleft-N）自动合并并正确缩进
      const flatQuoteListHtml = `
        <div id="js_content">
          <blockquote class="js_blockquote_wrap">
            <p>平铺列表说明：</p>
            <ul class="list-paddingleft-1"><li><p>父项</p></li></ul>
            <ul class="list-paddingleft-2"><li><p>子项 A</p></li></ul>
            <ul class="list-paddingleft-1"><li><p>兄弟项</p></li></ul>
          </blockquote>
        </div>
      `;
      const flatBlocks = splitBlocks(flatQuoteListHtml);
      const flatConverted = convertBlocks(flatBlocks);
      const flatQuoteMd = flatConverted[0]?.initialMarkdown || '';

      return {
        fixtureBlockCount: blocks.length,
        fixtureQuoteBlockCount: blocks.filter((b) => b.type === 'quote').length,
        fixtureListBlockCount: blocks.filter((b) => b.type === 'list').length,
        fixtureQuoteMd,

        complexBlockCount: complexBlocks.length,
        complexQuoteMd,

        flatBlockCount: flatBlocks.length,
        flatQuoteMd,
      };
    }, { fixtureHtml: fixtureQuoteList.RESULTS.content.after.html });

    assert.strictEqual(test4.fixtureBlockCount, 3, 'Fixture quote list must produce 3 blocks (p, quote, p)');
    assert.strictEqual(test4.fixtureQuoteBlockCount, 1, 'Fixture must have exactly 1 quote block');
    assert.strictEqual(test4.fixtureListBlockCount, 0, 'Internal list must NOT produce an independent list block');

    const expectedFixtureMd =
      '> 引用的第一段，说明下面这几条的来源。\n' +
      '> \n' +
      '> -   引用里的第一条\n' +
      '> -   引用里的第二条\n' +
      '> \n' +
      '> 引用的收尾一段。';
    assert.strictEqual(test4.fixtureQuoteMd, expectedFixtureMd, 'Fixture quote list Markdown must match regression baseline');

    // 复杂引用套列表断言
    assert.strictEqual(test4.complexBlockCount, 1, 'Complex quote wrapping list must be 1 quote block');
    assert(test4.complexQuoteMd.includes('> -   一级条目 1'), 'First level item must have > - prefix');
    assert(test4.complexQuoteMd.includes('>     -   二级嵌套子项 2.1'), 'Nested item must be indented 4 spaces after >');
    assert(test4.complexQuoteMd.includes('> 1.  第一步准备\n> 2.  第二步执行'), 'Ordered list in quote must be sequential with > prefix');

    // 平铺兄弟列表断言（假设 B）
    assert.strictEqual(test4.flatBlockCount, 1, 'Flat list inside quote must merge into 1 quote block');
    assert(test4.flatQuoteMd.includes('> -   父项\n>     -   子项 A\n> -   兄弟项'), 'Flat list inside quote must convert to properly indented nested list');
    console.log('✓ Quote wrapping list (including nested, ordered, and flat siblings) is 1 block with correct indentation');

    // --------------------------------------------------------------------------
    // Test 5: 引用内部的图片随块呈现，不产生独立的图片块
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Images inside blockquote remain in quote block without separate image blocks ---');

    const test5 = await page.evaluate(() => {
      const { splitBlocks, convertBlocks, buildArticleSnapshot } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/test-quote-images';

      const html = `
        <div id="js_content">
          <p>前文段落</p>
          <blockquote class="js_blockquote_wrap">
            <p><span leaf="">引言文字：架构示意图如下：</span></p>
            <p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/arch_pic/0?wx_fmt=png" alt="系统拓扑图" title="拓扑图标题"></p>
            <p><span leaf="">后置总结文字。</span></p>
          </blockquote>
          <p>后文段落</p>
        </div>
      `;

      const blocks = splitBlocks(html);
      const converted = convertBlocks(blocks, { baseUrl });

      const imageBlocks = blocks.filter((b) => b.type === 'image');
      const quoteBlock = blocks.find((b) => b.type === 'quote');
      const quoteConverted = converted.find((b) => b.type === 'quote');

      // 通过 buildArticleSnapshot 测试端到端收集 ImageAsset
      const snapshot = buildArticleSnapshot({
        kind: 'article',
        source: {
          title: '测试引用内图片',
          account: '测试号',
          publishedAt: '2026-09-12',
          url: baseUrl,
        },
        contentHtml: html,
        unstable: false,
        tabId: 1,
      });

      return {
        totalBlocks: blocks.length,
        imageBlocksCount: imageBlocks.length,
        quoteOriginalHtml: quoteBlock?.originalHtml || '',
        quoteMarkdown: quoteConverted?.initialMarkdown || '',
        snapshotImages: snapshot.images,
      };
    });

    assert.strictEqual(test5.totalBlocks, 3, 'Article must have 3 blocks (paragraph, quote, paragraph)');
    assert.strictEqual(test5.imageBlocksCount, 0, 'ZERO independent image blocks should be created');
    assert(
      test5.quoteMarkdown.includes('> ![系统拓扑图](https://mmbiz.qpic.cn/mmbiz_png/arch_pic/0?wx_fmt=png "拓扑图标题")'),
      'Image Markdown must be rendered inside quote block with > prefix'
    );
    assert.strictEqual(test5.snapshotImages.length, 1, 'Exactly 1 ImageAsset should be collected from the quote block');
    assert.strictEqual(
      test5.snapshotImages[0].url,
      'https://mmbiz.qpic.cn/mmbiz_png/arch_pic/0?wx_fmt=png',
      'Collected ImageAsset URL must match image data-src'
    );
    console.log('✓ Image inside quote is rendered within quote block, produces 0 independent image blocks, and is collected into ImageAssets');

    // --------------------------------------------------------------------------
    // Test 6: 构造用例连同预期输出回归基线验证（test/fixtures/constructed-quotes.json）
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Verifying constructed regression baseline (test/fixtures/constructed-quotes.json) ---');

    const fixturePath = path.resolve('test/fixtures/constructed-quotes.json');
    assert(fs.existsSync(fixturePath), 'test/fixtures/constructed-quotes.json must exist');
    const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const test6 = await page.evaluate((cases) => {
      const { splitBlocks, convertBlocks, buildArticleSnapshot } = window.__wetrim;

      return cases.map((c) => {
        const blocks = splitBlocks(c.html);
        const converted = convertBlocks(blocks, { baseUrl: c.baseUrl });
        const snapshot = buildArticleSnapshot({
          kind: 'article',
          source: {
            title: c.description,
            account: 'Test',
            publishedAt: '2026-09-12',
            url: c.baseUrl || 'https://mp.weixin.qq.com/s/baseline',
          },
          contentHtml: c.html,
          unstable: false,
          tabId: 1,
        });

        return {
          id: c.id,
          actualBlocksCount: blocks.length,
          actualBlockType: blocks[0]?.type,
          actualMarkdown: converted[0]?.initialMarkdown,
          actualImageUrls: snapshot.images.map((img) => img.url),
        };
      });
    }, fixtures);

    for (let i = 0; i < fixtures.length; i++) {
      const expected = fixtures[i];
      const actual = test6[i];

      assert.strictEqual(
        actual.actualBlocksCount,
        expected.expectedBlocksCount,
        `Fixture [${expected.id}]: blocks count must be ${expected.expectedBlocksCount}`
      );
      assert.strictEqual(
        actual.actualBlockType,
        expected.expectedBlockType,
        `Fixture [${expected.id}]: block type must be ${expected.expectedBlockType}`
      );
      assert.strictEqual(
        actual.actualMarkdown,
        expected.expectedMarkdown,
        `Fixture [${expected.id}]: Markdown must exactly match expected baseline`
      );

      if (expected.expectedImageAssets) {
        assert.deepStrictEqual(
          actual.actualImageUrls,
          expected.expectedImageAssets,
          `Fixture [${expected.id}]: collected image URLs must match expected`
        );
      }
      console.log(`  ✓ Fixture [${expected.id}] verified against regression baseline`);
    }
    console.log(`✓ All ${fixtures.length} constructed cases matched regression baseline exactly!`);

    // --------------------------------------------------------------------------
    // Test 7: 文档规范检查——保留「无真实样本」标注，PRODUCT.md 不得改成已验证
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Documentation discipline & "now cannot be treated as verified" compliance ---');

    const productMdPath = path.resolve('PRODUCT.md');
    const productMd = fs.readFileSync(productMdPath, 'utf8');

    // PRODUCT.md 「现在不得当作已验证」表格中必须严格保留对应条目
    assert(
      productMd.includes('| 引用套列表 / 多段落引用 / 公式 / 空 `js_darkmode` `<pre>` 噪声 | **无真实样本**，结论全部来自手工构造的 HTML |'),
      'PRODUCT.md MUST retain "引用套列表 / 多段落引用 ... 无真实样本，结论全部来自手工构造的 HTML" under "现在不得当作已验证"'
    );

    const conversionRulesPath = path.resolve('docs/conversion-rules.md');
    const conversionRules = fs.readFileSync(conversionRulesPath, 'utf8');

    assert(
      conversionRules.includes('多段落引用与引用套列表无真实样本') ||
        conversionRules.includes('多段落引用与引用套列表**无真实样本**') ||
        conversionRules.includes('**多段落引用与引用套列表无真实样本**'),
      'docs/conversion-rules.md §4.6 MUST state "多段落引用与引用套列表无真实样本"'
    );
    assert(
      conversionRules.includes('全部是单段落形态'),
      'docs/conversion-rules.md §4.6 MUST state "全部是单段落形态"'
    );
    console.log('✓ Documentation strictly complies with evidence discipline: PRODUCT.md and conversion-rules.md retain "无真实样本"');

    // --------------------------------------------------------------------------
    // Test 8: 全量 11 篇历史基准样例零回归自检
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Full 11 benchmarks article-wide regression self-test ---');

    const benchmarkSamples = [
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

    let totalBlocksChecked = 0;
    let totalQuoteBlocks = 0;

    for (const sample of benchmarkSamples) {
      const data = JSON.parse(execSync(`git show ${sample.commit}:${sample.path}`));
      const html = data.RESULTS.content.after.html;

      const result = await page.evaluate(({ articleHtml }) => {
        const { splitBlocks, convertBlocks } = window.__wetrim;
        const blocks = splitBlocks(articleHtml);
        const converted = convertBlocks(blocks);

        const emptyMarkdownBlocks = converted.filter(
          (b) => b.originalHtml.trim().length > 0 && b.initialMarkdown.length === 0
        );

        const quoteBlocks = converted.filter((b) => b.type === 'quote');

        return {
          totalBlocks: blocks.length,
          quoteCount: quoteBlocks.length,
          emptyMarkdownCount: emptyMarkdownBlocks.length,
        };
      }, { articleHtml: html });

      assert.strictEqual(
        result.emptyMarkdownCount,
        0,
        `Sample [${sample.name}]: zero blocks should have non-empty originalHtml but empty initialMarkdown`
      );

      totalBlocksChecked += result.totalBlocks;
      totalQuoteBlocks += result.quoteCount;

      console.log(`  ✓ [${sample.name}] ${result.totalBlocks} blocks (${result.quoteCount} quote blocks). 0 empty MD.`);
    }

    assert.strictEqual(totalQuoteBlocks, 7, 'Total quote blocks across 11 benchmarks must be exactly 7 (5 real + 2 fixtures)');
    console.log(`\n======================================================`);
    console.log(`✓ 11/11 Benchmark samples passed all Self-Tests!`);
    console.log(`✓ Total blocks checked: ${totalBlocksChecked}, Total quote blocks: ${totalQuoteBlocks}`);
    console.log(`✓ Zero blocks with non-empty originalHtml had empty initialMarkdown!`);
    console.log(`✓ All Issue #21 Acceptance Criteria Verified Successfully!`);
    console.log(`======================================================`);
  } finally {
    if (browser) await browser.close();
  }
}

run().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
