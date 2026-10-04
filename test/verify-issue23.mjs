import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';

async function run() {
  console.log('==> Starting Issue #23 TDD Verification (Rich Media, Formula, Unknown Content)...');

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
    // Test 1 (Slice 1): Rich media blocks: mp-common-profile, mp-common-miniprogram, video, audio
    // --------------------------------------------------------------------------
    console.log('\n--- Test 1 (Slice 1): Rich media blocks attributes, placeholders & notes ---');

    const test1 = await page.evaluate(() => {
      const { splitBlocks, convertBlock, buildArticleSnapshot } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/sample-richmedia';

      // 1. mp-common-profile with full attributes (nickname, signature, avatar headimg, and url)
      const htmlProfile = `
        <section class="mp_profile_iframe_wrp">
          <mp-common-profile
            class="js_uneditable custom_select_card mp_profile_iframe"
            data-pluginname="mpprofile"
            data-nickname="针刀精细解剖"
            data-alias="zhendaojingxijiepou"
            data-headimg="http://mmbiz.qpic.cn/profile_avatar.png?wx_fmt=png"
            data-signature="发展针刀事业，创造一流针刀水平！"
            data-url="https://mp.weixin.qq.com/mp/profile_page?biz=123">
          </mp-common-profile>
        </section>
      `;

      // 2. mp-common-profile minimal (no nickname, no avatar, no signature)
      const htmlProfileEmpty = `
        <section class="mp_profile_iframe_wrp">
          <mp-common-profile class="js_uneditable custom_select_card"></mp-common-profile>
        </section>
      `;

      // 3. mp-common-miniprogram with title, cover, and link
      const htmlMiniProgram = `
        <mp-common-miniprogram
          data-miniprogram-title="AI 搜索新体验"
          data-miniprogram-nickname="腾讯元宝"
          data-miniprogram-imageurl="https://mmbiz.qpic.cn/miniprogram_cover.png"
          href="https://mp.weixin.qq.com/mp/waerrpage?appid=wx123">
        </mp-common-miniprogram>
      `;

      // 4. mp-common-miniprogram minimal (no title, no link)
      const htmlMiniProgramEmpty = `
        <mp-common-miniprogram></mp-common-miniprogram>
      `;

      // 5. Video and Audio
      const htmlVideo = `
        <iframe
          class="video_iframe"
          data-title="解剖教学演示"
          data-src="https://v.qq.com/iframe/player.html?vid=123">
        </iframe>
      `;
      const htmlAudio = `
        <mpvoice
          name="课程伴读音频"
          data-src="https://res.wx.qq.com/voice/sample.mp3">
        </mpvoice>
      `;
      const htmlVideoEmpty = `<iframe class="video_iframe"></iframe>`;

      const blockProfile = convertBlock(splitBlocks(htmlProfile)[0], { baseUrl });
      const blockProfileEmpty = convertBlock(splitBlocks(htmlProfileEmpty)[0], { baseUrl });
      const blockMiniProgram = convertBlock(splitBlocks(htmlMiniProgram)[0], { baseUrl });
      const blockMiniProgramEmpty = convertBlock(splitBlocks(htmlMiniProgramEmpty)[0], { baseUrl });
      const blockVideo = convertBlock(splitBlocks(htmlVideo)[0], { baseUrl });
      const blockVideoEmpty = convertBlock(splitBlocks(htmlVideoEmpty)[0], { baseUrl });
      const blockAudio = convertBlock(splitBlocks(htmlAudio)[0], { baseUrl });

      // Snapshot test for collecting avatar headimg
      const capture = {
        kind: 'article',
        source: { url: baseUrl, title: '富媒体测试', author: '', accountName: '' },
        contentHtml: `<div id="js_content">${htmlProfile}${htmlMiniProgram}</div>`,
        unstable: false,
      };
      const snapshot = buildArticleSnapshot(capture);

      return {
        profile: {
          type: blockProfile.type,
          markdown: blockProfile.initialMarkdown,
          notes: blockProfile.notes,
        },
        profileEmpty: {
          type: blockProfileEmpty.type,
          markdown: blockProfileEmpty.initialMarkdown,
          notes: blockProfileEmpty.notes,
        },
        miniProgram: {
          type: blockMiniProgram.type,
          markdown: blockMiniProgram.initialMarkdown,
          notes: blockMiniProgram.notes,
        },
        miniProgramEmpty: {
          type: blockMiniProgramEmpty.type,
          markdown: blockMiniProgramEmpty.initialMarkdown,
          notes: blockMiniProgramEmpty.notes,
        },
        video: {
          type: blockVideo.type,
          markdown: blockVideo.initialMarkdown,
          notes: blockVideo.notes,
        },
        videoEmpty: {
          type: blockVideoEmpty.type,
          markdown: blockVideoEmpty.initialMarkdown,
          notes: blockVideoEmpty.notes,
        },
        audio: {
          type: blockAudio.type,
          markdown: blockAudio.initialMarkdown,
          notes: blockAudio.notes,
        },
        snapshotImages: snapshot.images.map((img) => img.url),
      };
    });

    // 1. mp-common-profile assertions
    assert.strictEqual(test1.profile.type, 'richMedia', 'Profile block must have type "richMedia"');
    assert(
      test1.profile.notes.some((n) => n.code === 'richmedia-placeholder'),
      'Profile block must have richmedia-placeholder note'
    );
    assert(
      test1.profile.markdown.includes('![针刀精细解剖](http://mmbiz.qpic.cn/profile_avatar.png?wx_fmt=png)') ||
      test1.profile.markdown.includes('![头像](http://mmbiz.qpic.cn/profile_avatar.png?wx_fmt=png)') ||
      test1.profile.markdown.includes('http://mmbiz.qpic.cn/profile_avatar.png?wx_fmt=png'),
      'Profile avatar headimg must be extracted as image in markdown'
    );
    assert(
      test1.profile.markdown.includes('[【公众号】针刀精细解剖](https://mp.weixin.qq.com/mp/profile_page?biz=123)') ||
      test1.profile.markdown.includes('【公众号】[针刀精细解剖](https://mp.weixin.qq.com/mp/profile_page?biz=123)') ||
      test1.profile.markdown.includes('【公众号】针刀精细解剖'),
      'Profile nickname and link must be preserved in markdown'
    );
    assert(
      test1.profile.markdown.includes('发展针刀事业，创造一流针刀水平！'),
      'Profile signature must be preserved in markdown'
    );

    // Profile empty fallback
    assert(
      test1.profileEmpty.markdown.includes('【公众号】'),
      'Empty profile must fallback to category placeholder 【公众号】 without fake data'
    );
    assert(
      !test1.profileEmpty.markdown.includes('【公众号名片】'),
      'Must use standard 【公众号】 placeholder per specs'
    );
    assert(
      !test1.profileEmpty.markdown.includes('mpprofile'),
      'Must not leak data-pluginname mpprofile into nickname'
    );

    // 2. mp-common-miniprogram assertions
    assert.strictEqual(test1.miniProgram.type, 'richMedia', 'MiniProgram block must have type "richMedia"');
    assert(
      test1.miniProgram.notes.some((n) => n.code === 'richmedia-placeholder'),
      'MiniProgram block must have richmedia-placeholder note'
    );
    assert(
      test1.miniProgram.markdown.includes('[【小程序】AI 搜索新体验](https://mp.weixin.qq.com/mp/waerrpage?appid=wx123)') ||
      test1.miniProgram.markdown.includes('【小程序】[AI 搜索新体验](https://mp.weixin.qq.com/mp/waerrpage?appid=wx123)') ||
      test1.miniProgram.markdown.includes('【小程序】AI 搜索新体验'),
      'MiniProgram title and link must be preserved in markdown'
    );
    assert(
      test1.miniProgramEmpty.markdown.includes('【小程序】'),
      'Empty miniprogram must fallback to category placeholder 【小程序】'
    );

    // 3. Video and Audio assertions
    assert(
      test1.video.notes.some((n) => n.code === 'richmedia-placeholder'),
      'Video block must have richmedia-placeholder note'
    );
    assert(
      test1.video.markdown.includes('[【视频】解剖教学演示](https://v.qq.com/iframe/player.html?vid=123)') ||
      test1.video.markdown.includes('【视频】[解剖教学演示](https://v.qq.com/iframe/player.html?vid=123)') ||
      test1.video.markdown.includes('【视频】解剖教学演示'),
      'Video title and link must be preserved'
    );
    assert(
      test1.videoEmpty.markdown.includes('【视频】'),
      'Empty video must fallback to category placeholder 【视频】'
    );

    assert(
      test1.audio.notes.some((n) => n.code === 'richmedia-placeholder'),
      'Audio block must have richmedia-placeholder note'
    );
    assert(
      test1.audio.markdown.includes('[【音频】课程伴读音频](https://res.wx.qq.com/voice/sample.mp3)') ||
      test1.audio.markdown.includes('【音频】[课程伴读音频](https://res.wx.qq.com/voice/sample.mp3)') ||
      test1.audio.markdown.includes('【音频】课程伴读音频'),
      'Audio name and link must be preserved'
    );

    // 4. Snapshot images collection for avatar
    assert(
      test1.snapshotImages.some((url) => url.includes('profile_avatar.png')),
      'Profile headimg must be collected into snapshot.images ImageAsset list'
    );

    console.log('✓ Slice 1: Rich media attributes, placeholders, notes, and avatar collection verified');

    // --------------------------------------------------------------------------
    // Test 2 (Slice 2): Formula block splitting, dialect ($ vs $$), and image formulas
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2 (Slice 2): Formula block splitting, dialect & image formulas ---');

    const test2 = await page.evaluate(() => {
      const { splitBlocks, convertBlock, buildArticleSnapshot } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/sample-formula';

      // 1. Inline formula inside sentence:
      // CRITICAL: "行内公式 <mjx-container/> 之后。 不得被切成段落 / 独立公式 / 段落三块（#13 的切块器就是这么错的）"
      const htmlInline = `<p>行内公式 <mjx-container data-tex="E=mc^2"></mjx-container> 之后。</p>`;
      const blocksInline = splitBlocks(htmlInline);
      const convertedInline = convertBlock(blocksInline[0], { baseUrl });

      // 1.2 Inline formula wrapped in span inside sentence:
      const htmlInlineWrapped = `<p>前缀文字 <span><mjx-container data-tex="x + y = z"></mjx-container></span> 后缀文字。</p>`;
      const blocksInlineWrapped = splitBlocks(htmlInlineWrapped);
      const convertedInlineWrapped = convertBlock(blocksInlineWrapped[0], { baseUrl });

      // 2. Block-level independent formula (occupies entire paragraph/container alone):
      const htmlBlockFormulaP = `<p><mjx-container data-tex="\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}"></mjx-container></p>`;
      const blocksBlockP = splitBlocks(htmlBlockFormulaP);
      const convertedBlockP = convertBlock(blocksBlockP[0], { baseUrl });

      const htmlBlockFormulaDiv = `<div><mjx-container data-tex="\\sum_{i=1}^n i = \\frac{n(n+1)}{2}"></mjx-container></div>`;
      const blocksBlockDiv = splitBlocks(htmlBlockFormulaDiv);
      const convertedBlockDiv = convertBlock(blocksBlockDiv[0], { baseUrl });

      // 3. Various formula formats:
      // MathJax 2 (.MathJax + data-formula)
      const htmlMathJax2 = `<p>已知 <span class="MathJax" data-formula="\\alpha + \\beta = \\gamma"></span> 为常数。</p>`;
      const convertedMathJax2 = convertBlock(splitBlocks(htmlMathJax2)[0], { baseUrl });

      // KaTeX (.katex + annotation[encoding*="tex"])
      const htmlKaTeX = `<p><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\\sqrt{x^2 + y^2}</annotation></semantics></math></span></span></p>`;
      const blocksKaTeX = splitBlocks(htmlKaTeX);
      const convertedKaTeX = convertBlock(blocksKaTeX[0], { baseUrl });

      // MathML (<math><semantics><annotation>)
      const htmlMathML = `<p>求极限 <math><semantics><annotation encoding="application/x-tex">\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1</annotation></semantics></math>。</p>`;
      const convertedMathML = convertBlock(splitBlocks(htmlMathML)[0], { baseUrl });

      // Formula without TeX attribute: readable placeholder 【公式】
      const htmlEmptyFormulaInline = `<p>未知公式 <mjx-container></mjx-container> 结束。</p>`;
      const convertedEmptyInline = convertBlock(splitBlocks(htmlEmptyFormulaInline)[0], { baseUrl });

      const htmlEmptyFormulaBlock = `<p><mjx-container></mjx-container></p>`;
      const blocksEmptyBlock = splitBlocks(htmlEmptyFormulaBlock);
      const convertedEmptyBlock = convertBlock(blocksEmptyBlock[0], { baseUrl });

      // 4. Formula as image (LaTeX screenshot):
      // "公式若是图片（LaTeX 截图）走图片块的通用逻辑"
      const htmlFormulaImgAlone = `<p><img src="/tex.png" data-src="https://mmbiz.qpic.cn/tex.png" alt="E=mc^2" /></p>`;
      const blocksFormulaImgAlone = splitBlocks(htmlFormulaImgAlone);
      const convertedFormulaImgAlone = convertBlock(blocksFormulaImgAlone[0], { baseUrl });

      const htmlFormulaImgMixed = `<p>公式说明：<img src="/tex.png" data-src="https://mmbiz.qpic.cn/tex.png" alt="E=mc^2" /> 如上所示。</p>`;
      const blocksFormulaImgMixed = splitBlocks(htmlFormulaImgMixed);

      // Snapshot test with mixed content
      const capture = {
        kind: 'article',
        source: { url: baseUrl, title: '公式测试', author: '', accountName: '' },
        contentHtml: `<div id="js_content">${htmlInline}${htmlBlockFormulaP}${htmlFormulaImgAlone}</div>`,
        unstable: false,
      };
      const snapshot = buildArticleSnapshot(capture);

      return {
        inline: {
          blocksCount: blocksInline.length,
          type: convertedInline.type,
          markdown: convertedInline.initialMarkdown,
        },
        inlineWrapped: {
          blocksCount: blocksInlineWrapped.length,
          type: convertedInlineWrapped.type,
          markdown: convertedInlineWrapped.initialMarkdown,
        },
        blockP: {
          blocksCount: blocksBlockP.length,
          type: convertedBlockP.type,
          markdown: convertedBlockP.initialMarkdown,
        },
        blockDiv: {
          blocksCount: blocksBlockDiv.length,
          type: convertedBlockDiv.type,
          markdown: convertedBlockDiv.initialMarkdown,
        },
        mathJax2: {
          markdown: convertedMathJax2.initialMarkdown,
        },
        katex: {
          blocksCount: blocksKaTeX.length,
          type: convertedKaTeX.type,
          markdown: convertedKaTeX.initialMarkdown,
        },
        mathML: {
          markdown: convertedMathML.initialMarkdown,
        },
        emptyInline: {
          markdown: convertedEmptyInline.initialMarkdown,
        },
        emptyBlock: {
          type: convertedEmptyBlock.type,
          markdown: convertedEmptyBlock.initialMarkdown,
        },
        formulaImgAlone: {
          blocksCount: blocksFormulaImgAlone.length,
          type: convertedFormulaImgAlone.type,
          markdown: convertedFormulaImgAlone.initialMarkdown,
        },
        formulaImgMixed: {
          blocksCount: blocksFormulaImgMixed.length,
          types: blocksFormulaImgMixed.map((b) => b.type),
        },
        snapshotBlocks: snapshot.blocks.map((b) => ({ type: b.type, order: b.order })),
        snapshotImages: snapshot.images.map((img) => img.url),
      };
    });

    // Assertions 1: Inline formula stays in paragraph and is NOT chopped
    assert.strictEqual(
      test2.inline.blocksCount,
      1,
      'CRITICAL: Sentence with inline formula MUST NOT be cut into 3 blocks (must be exactly 1 block)'
    );
    assert.strictEqual(
      test2.inline.type,
      'paragraph',
      'Inline formula block type must be "paragraph"'
    );
    assert(
      test2.inline.markdown.includes('$E=mc^2$'),
      `Inline formula output dialect must be $...$, got: ${test2.inline.markdown}`
    );
    assert(
      test2.inline.markdown.includes('行内公式') && test2.inline.markdown.includes('之后。'),
      'Text around inline formula must remain seamlessly in the same paragraph'
    );

    // Assertions 1.2: Inline formula wrapped in span
    assert.strictEqual(
      test2.inlineWrapped.blocksCount,
      1,
      'Inline formula wrapped in span must also be 1 block'
    );
    assert(
      !test2.inlineWrapped.markdown.includes('$$'),
      `Wrapped inline formula must not output $$, got: ${test2.inlineWrapped.markdown}`
    );
    assert(
      test2.inlineWrapped.markdown.includes('$x + y = z$') ||
      test2.inlineWrapped.markdown.includes('$x+y=z$'),
      'Wrapped inline formula must convert to $...$'
    );
    assert(
      test2.inlineWrapped.markdown.includes('前缀文字') && test2.inlineWrapped.markdown.includes('后缀文字。'),
      'Text around wrapped inline formula must remain seamlessly in the same paragraph'
    );

    // Assertions 2: Block-level standalone formulas
    assert.strictEqual(
      test2.blockP.blocksCount,
      1,
      'Standalone formula in <p> must be exactly 1 block'
    );
    assert.strictEqual(
      test2.blockP.type,
      'formula',
      'Standalone formula in <p> must have type "formula"'
    );
    assert(
      test2.blockP.markdown.startsWith('$$') && test2.blockP.markdown.endsWith('$$'),
      `Standalone formula output dialect must be $$...$$, got: ${test2.blockP.markdown}`
    );
    assert(
      test2.blockP.markdown.includes('\\int_0^\\infty'),
      'Standalone formula TeX must be preserved'
    );

    assert.strictEqual(
      test2.blockDiv.type,
      'formula',
      'Standalone formula in <div> must have type "formula"'
    );
    assert(
      test2.blockDiv.markdown.startsWith('$$') && test2.blockDiv.markdown.endsWith('$$'),
      'Standalone formula in <div> dialect must be $$...$$'
    );

    // Assertions 3: Various formula carriers (MathJax 2, KaTeX, MathML)
    assert(
      test2.mathJax2.markdown.includes('$\\alpha + \\beta = \\gamma$'),
      'MathJax 2 formula must be converted to $...$'
    );
    assert.strictEqual(
      test2.katex.type,
      'formula',
      'Standalone KaTeX formula must have type "formula"'
    );
    assert(
      test2.katex.markdown.includes('$$\\sqrt{x^2 + y^2}$$'),
      'KaTeX formula must be converted to $$...$$'
    );
    assert(
      test2.mathML.markdown.includes('$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$'),
      'MathML formula must be converted to $...$'
    );

    // Formula without TeX attribute fallback
    assert(
      test2.emptyInline.markdown.includes('【公式】') || test2.emptyInline.markdown.includes('$【公式】$'),
      'Inline formula without TeX must fallback to readable placeholder 【公式】'
    );
    assert(
      test2.emptyBlock.markdown.includes('【公式】') || test2.emptyBlock.markdown.includes('$$【公式】$$'),
      'Block formula without TeX must fallback to readable placeholder 【公式】'
    );

    // Assertions 4: Formula as image (LaTeX screenshot)
    assert.strictEqual(
      test2.formulaImgAlone.blocksCount,
      1,
      'Formula image alone must be 1 block'
    );
    assert.strictEqual(
      test2.formulaImgAlone.type,
      'image',
      'Formula image MUST have type "image", NOT "formula"'
    );
    assert(
      test2.formulaImgAlone.markdown.includes('![E=mc^2](https://mmbiz.qpic.cn/tex.png)'),
      'Formula image markdown must follow image syntax'
    );

    assert.strictEqual(
      test2.formulaImgMixed.blocksCount,
      3,
      'Mixed text and formula image must split into 3 blocks (paragraph, image, paragraph)'
    );
    assert.deepStrictEqual(
      test2.formulaImgMixed.types,
      ['paragraph', 'image', 'paragraph'],
      'Mixed text and formula image types must be paragraph, image, paragraph'
    );

    // Assertions 5: Snapshot blocks and image collection
    assert.strictEqual(test2.snapshotBlocks.length, 3, 'Snapshot must contain paragraph, formula, image');
    assert.strictEqual(test2.snapshotBlocks[0].type, 'paragraph');
    assert.strictEqual(test2.snapshotBlocks[1].type, 'formula');
    assert.strictEqual(test2.snapshotBlocks[2].type, 'image');
    assert(
      test2.snapshotImages.some((url) => url.includes('tex.png')),
      'Formula image must be collected into snapshot.images'
    );

    console.log('✓ Slice 2: Formula block splitting, dialect, and image formula logic verified');

    // --------------------------------------------------------------------------
    // Test 3 (Slice 3): Unknown content blocks & Single-block degradation
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3 (Slice 3): Unknown content blocks & Degradation ---');

    const test3 = await page.evaluate(() => {
      const { splitBlocks, convertBlock } = window.__wetrim;
      const baseUrl = 'https://mp.weixin.qq.com/s/sample-unknown';

      // 1. Unknown non-text block elements (canvas, embed, object)
      // These must NOT be silently dropped!
      const htmlCanvas = `<canvas id="graph-canvas" width="300" height="200" data-chart="sales"></canvas>`;
      const blocksCanvas = splitBlocks(htmlCanvas);
      const convertedCanvas = convertBlock(blocksCanvas[0], { baseUrl });

      const htmlEmbed = `<embed type="application/pdf" src="/files/report.pdf" width="600" height="400" />`;
      const blocksEmbed = splitBlocks(htmlEmbed);
      const convertedEmbed = convertBlock(blocksEmbed[0], { baseUrl });

      // 2. Normal inline wrapper tags:
      // "普通的行内包装标签不因此变成未知块——它们按 §1.1 去标签留内容"
      const htmlNormalWrapper = `<p><span class="editor-wrap" style="color:red">正文第一段 <strong leaf="">粗体字</strong></span></p>`;
      const blocksNormal = splitBlocks(htmlNormalWrapper);
      const convertedNormal = convertBlock(blocksNormal[0], { baseUrl });

      // 3. Empty inline wrapper: must produce 0 blocks
      const htmlEmptyWrapper = `<p><span><span textstyle=""></span></span></p>`;
      const blocksEmpty = splitBlocks(htmlEmptyWrapper);

      // 4. Block that converts to empty string -> degrades to unknown block
      const dummyBlock = {
        id: 'dummy-1',
        order: 1,
        type: 'paragraph',
        originalHtml: '<div class="ghost-wrapper"><!-- comment only --></div>',
        initialMarkdown: '',
        editedMarkdown: null,
        included: true,
        notes: [],
      };
      const convertedDegraded = convertBlock(dummyBlock, { baseUrl });

      return {
        canvas: {
          blocksCount: blocksCanvas.length,
          type: convertedCanvas.type,
          markdown: convertedCanvas.initialMarkdown,
          notes: convertedCanvas.notes,
          included: convertedCanvas.included,
        },
        embed: {
          blocksCount: blocksEmbed.length,
          type: convertedEmbed.type,
          markdown: convertedEmbed.initialMarkdown,
          notes: convertedEmbed.notes,
        },
        normalWrapper: {
          blocksCount: blocksNormal.length,
          type: convertedNormal.type,
          markdown: convertedNormal.initialMarkdown,
          notes: convertedNormal.notes,
        },
        emptyWrapperCount: blocksEmpty.length,
        degraded: {
          type: convertedDegraded.type,
          markdown: convertedDegraded.initialMarkdown,
          notes: convertedDegraded.notes,
        },
      };
    });

    // 1. Unknown element assertions
    assert.strictEqual(test3.canvas.blocksCount, 1, 'Canvas must not be dropped; must split into 1 block');
    assert.strictEqual(test3.canvas.type, 'unknown', 'Canvas block must have type "unknown"');
    assert(
      test3.canvas.notes.some((n) => n.code === 'convert-failed'),
      'Canvas block must have convert-failed note'
    );
    assert(
      test3.canvas.markdown.includes('【未识别内容】') || test3.canvas.markdown.includes('【未知内容】'),
      'Canvas block must present readable placeholder'
    );
    assert.strictEqual(test3.canvas.included, true, 'Unknown block must be included=true by default for user review');

    assert.strictEqual(test3.embed.blocksCount, 1, 'Embed must not be dropped; must split into 1 block');
    assert.strictEqual(test3.embed.type, 'unknown', 'Embed block must have type "unknown"');
    assert(
      test3.embed.notes.some((n) => n.code === 'convert-failed'),
      'Embed block must have convert-failed note'
    );

    // 2. Normal inline wrapper assertions
    assert.strictEqual(test3.normalWrapper.blocksCount, 1, 'Normal inline wrapper must be 1 block');
    assert.strictEqual(test3.normalWrapper.type, 'paragraph', 'Normal inline wrapper must remain paragraph, NOT unknown');
    assert.strictEqual(test3.normalWrapper.notes.length, 0, 'Normal inline wrapper must not have degradation notes');
    assert(test3.normalWrapper.markdown.includes('正文第一段 **粗体字**'));

    // 3. Empty inline wrapper assertion
    assert.strictEqual(test3.emptyWrapperCount, 0, 'Pure empty inline wrapper must not produce phantom blocks');

    // 4. Degradation assertion
    assert.strictEqual(test3.degraded.type, 'unknown', 'Block converting to empty must degrade to unknown');
    assert(test3.degraded.notes.some((n) => n.code === 'convert-failed'));

    console.log('✓ Slice 3: Unknown content blocks, inline wrapper preservation & degradation verified');

    // --------------------------------------------------------------------------
    // Test 4 (Slice 4): Real WeChat Article Benchmark Verification (mp-common-profile)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4 (Slice 4): Real WeChat Article Benchmark Verification (Photo-Heavy Sample) ---');

    const { execSync } = await import('child_process');
    const photoData = JSON.parse(
      execSync('git show 64d097d:output/wayfinder-12/samples/wetrim-sample-photo-heavy.json', {
        maxBuffer: 50 * 1024 * 1024,
      })
    );

    const test4 = await page.evaluate(
      ({ photoHtml, photoUrl }) => {
        const { splitBlocks, convertBlocks, buildArticleSnapshot, renderMarkdown } = window.__wetrim;

        const capture = {
          kind: 'article',
          source: {
            url: photoUrl,
            title: '真实图文样本',
            author: '针刀精细解剖',
            accountName: '针刀精细解剖',
          },
          contentHtml: photoHtml,
          unstable: false,
        };

        const snapshot = buildArticleSnapshot(capture);

        // 查找真实公众号名片块
        const profileBlock = snapshot.blocks.find(
          (b) => b.type === 'richMedia' || b.originalHtml.includes('mp-common-profile')
        );

        // 安全预览渲染测试
        const renderedHtml = profileBlock ? renderMarkdown(profileBlock.initialMarkdown) : '';
        const previewDoc = new DOMParser().parseFromString(renderedHtml, 'text/html');

        return {
          totalBlocks: snapshot.blocks.length,
          profileBlock: profileBlock
            ? {
                type: profileBlock.type,
                order: profileBlock.order,
                markdown: profileBlock.initialMarkdown,
                notes: profileBlock.notes,
              }
            : null,
          headimgInImages: snapshot.images.some((img) => img.url.includes('uj3ToYtcVkHvQHUko3Rq0ADGq9jOia5JZwibBGC6CBE0D6uxviafPBQ93Hl5q5vzNcUUdk6P2icxPtW0KrVCDJiamVQ')),
          preview: {
            hasImg: Boolean(previewDoc.querySelector('img')),
            imgSrc: previewDoc.querySelector('img')?.getAttribute('src') || '',
            text: previewDoc.body.textContent || '',
          },
        };
      },
      {
        photoHtml: photoData.RESULTS.content.after.html,
        photoUrl: photoData.RESULTS.content.meta?.url || 'https://mp.weixin.qq.com/s/photo',
      }
    );

    assert(test4.profileBlock !== null, 'Real article MUST contain mp-common-profile block');
    assert.strictEqual(test4.profileBlock.type, 'richMedia', 'Real profile block must have type "richMedia"');
    assert(
      test4.profileBlock.notes.some((n) => n.code === 'richmedia-placeholder'),
      'Real profile block must have richmedia-placeholder note'
    );
    assert(
      test4.profileBlock.markdown.includes('【公众号】针刀精细解剖'),
      `Real profile block must contain 【公众号】针刀精细解剖, got: ${test4.profileBlock.markdown}`
    );
    assert(
      test4.profileBlock.markdown.includes('发展针刀事业，创造一流针刀水平！'),
      'Real profile block must contain signature'
    );
    assert(
      test4.profileBlock.markdown.includes('http://mmbiz.qpic.cn/mmbiz_png/uj3ToYtcVkHvQHUko3Rq0ADGq9jOia5JZwibBGC6CBE0D6uxviafPBQ93Hl5q5vzNcUUdk6P2icxPtW0KrVCDJiamVQ'),
      'Real profile block markdown must contain headimg avatar'
    );
    assert(
      test4.headimgInImages,
      'Real profile headimg must be collected into snapshot.images'
    );

    // Preview assertions
    assert(test4.preview.hasImg, 'Preview must render avatar img');
    assert(test4.preview.text.includes('【公众号】针刀精细解剖'), 'Preview must render nickname placeholder');
    assert(test4.preview.text.includes('发展针刀事业，创造一流针刀水平！'), 'Preview must render signature');

    console.log('✓ Slice 4: Real article benchmark (Photo-Heavy Sample mp-common-profile) & safe preview verified');

    console.log('\n==> All Issue #23 tests passed successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
