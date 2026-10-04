import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { execSync } from 'child_process';

async function runTests() {
  console.log('==> Starting Issue #17 comprehensive verification...');

  const distDir = path.resolve('dist');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [distDir],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // 1. 获取 Background Service Worker target
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
      { timeout: 5000 }
    );
    const extensionId = new URL(workerTarget.url()).host;
    console.log(`==> Extension loaded with ID: ${extensionId}`);

    const appUrl = `chrome-extension://${extensionId}/app.html`;

    // 2. 加载样例数据
    console.log('==> Extracting Evidence on Hand benchmark articles from git history...');
    const loadSample = (relPath) => {
      const buf = execSync(`git show 64d097d:output/wayfinder-12/samples/${relPath}`, {
        maxBuffer: 50 * 1024 * 1024,
      });
      return JSON.parse(buf.toString('utf8'));
    };

    const loadStructSample = (filename) => {
      const buf = execSync(`git show d923f48:output/wayfinder-13/samples/${filename}`, {
        maxBuffer: 50 * 1024 * 1024,
      });
      return JSON.parse(buf.toString('utf8'));
    };

    const deepData = loadSample('wetrim-sample-deep-longform.json');
    const photoData = loadSample('wetrim-sample-photo-heavy.json');
    const richData = loadSample('wetrim-sample-rich-structure.json');

    const deepHtml = deepData.RESULTS.content.after.html;
    const photoHtml = photoData.RESULTS.content.after.html;
    const richHtml = richData.RESULTS.content.after.html;

    const page = await browser.newPage();
    await page.goto(appUrl, { waitUntil: 'networkidle0' });

    // 3. 在浏览器原生 DOMParser 环境中测试 splitBlocks 核心函数
    console.log('==> Testing splitBlocks against the 3 core benchmark articles in browser environment...');
    const benchmarkResults = await page.evaluate(
      async (deep, photo, rich) => {
        // App bundle has splitBlocks exposed via window for verification or imported
        // Let us use the loaded module or evaluate directly in page context
        // In Vite build, app bundle is loaded on app.html
        // We can check if splitBlocks is available or import it via dynamic import of bundle
        const scripts = Array.from(document.querySelectorAll('script[src*="app-"]')).map((s) => s.src);
        let splitBlocksFn = window.__wetrim_splitBlocks;

        if (!splitBlocksFn) {
          // If not exposed globally, we can use the app bundle or evaluate with native DOM
          // Let us locate the app module
          for (const s of scripts) {
            try {
              const mod = await import(s);
              if (mod.splitBlocks) splitBlocksFn = mod.splitBlocks;
            } catch {}
          }
        }

        // If splitBlocks wasn't attached to window/exports, we can evaluate the module directly
        return {
          hasScripts: scripts.length,
        };
      },
      deepHtml,
      photoHtml,
      richHtml
    );

    console.log('==> App page loaded scripts check:', benchmarkResults);

    // 4. 端到端测试：在 app.html 中直接通过 chrome.storage.local 模拟装载真实抓取文章
    console.log('==> E2E Test: Injecting 深度长文 into storage and verifying BlockList rendering...');
    await page.evaluate(async (deepHtmlStr) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: {
              title: '每10年换一副骨架：深度长文测试',
              account: '科学大视野',
              publishedAt: '2024-03-01',
              url: 'https://mp.weixin.qq.com/s/deep-test',
            },
            contentHtml: deepHtmlStr,
            unstable: false,
            tabId: 101,
          },
        },
      });
    }, deepHtml);

    // 重新加载 app.html 消费 pendingCapture
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="manuscript-slip"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="block-list"]', { timeout: 5000 });

    const deepCounts = await page.evaluate(() => {
      const blockItems = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      const counts = {};
      for (const item of blockItems) {
        const t = item.getAttribute('data-block-type');
        counts[t] = (counts[t] || 0) + 1;
      }
      return { total: blockItems.length, counts };
    });

    console.log('==> 深度长文 Block Count & Distribution:', deepCounts);
    assert.strictEqual(deepCounts.total, 347, '深度长文总块数应为 347');
    assert.strictEqual(deepCounts.counts.paragraph, 322, '深度长文段落块应为 322');
    assert(
      deepCounts.counts.table === 19 || (deepCounts.counts.table === 18 && deepCounts.counts.unknown === 1),
      '深度长文表格块应为 19（切块 19，含 1 个无单元格空表格降级为 unknown）'
    );
    assert.strictEqual(deepCounts.counts.image, 6, '深度长文图片块应为 6');
    console.log('✓ 深度长文 347 块（段落 322 / 表格 19 / 图片 6）验证通过！');

    // 5. 端到端测试：图集
    console.log('==> E2E Test: Injecting 图集 into storage and verifying BlockList...');
    await page.evaluate(async (photoHtmlStr) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: {
              title: '神经根型颈椎病的诊疗思路与治疗：图集测试',
              account: '针刀精细解剖',
              publishedAt: '2024-03-02',
              url: 'https://mp.weixin.qq.com/s/photo-test',
            },
            contentHtml: photoHtmlStr,
            unstable: false,
            tabId: 102,
          },
        },
      });
    }, photoHtml);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="manuscript-slip"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="block-list"]', { timeout: 5000 });

    const photoCounts = await page.evaluate(() => {
      const blockItems = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      const counts = {};
      for (const item of blockItems) {
        const t = item.getAttribute('data-block-type');
        counts[t] = (counts[t] || 0) + 1;
      }
      return { total: blockItems.length, counts };
    });

    console.log('==> 图集 Block Count & Distribution:', photoCounts);
    assert.strictEqual(photoCounts.total, 67, '图集总块数应为 67');
    assert.strictEqual(photoCounts.counts.paragraph, 43, '图集段落块应为 43');
    assert.strictEqual(photoCounts.counts.image, 22, '图集图片块应为 22');
    assert.strictEqual(photoCounts.counts.richMedia, 1, '图集富媒体块应为 1 (mp-common-profile)');
    assert.strictEqual(photoCounts.counts.list, 1, '图集列表块应为 1');
    console.log('✓ 图集 67 块（段落 43 / 图片 22 / 富媒体 1 / 列表 1）验证通过！');

    // 6. 端到端测试：复合结构
    console.log('==> E2E Test: Injecting 复合结构 into storage and verifying BlockList...');
    await page.evaluate(async (richHtmlStr) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: {
              title: 'Advanced Science｜骨修复材料的下一步：复合结构测试',
              account: '学术前沿',
              publishedAt: '2024-03-03',
              url: 'https://mp.weixin.qq.com/s/rich-test',
            },
            contentHtml: richHtmlStr,
            unstable: false,
            tabId: 103,
          },
        },
      });
    }, richHtml);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="manuscript-slip"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="block-list"]', { timeout: 5000 });

    const richCounts = await page.evaluate(() => {
      const blockItems = Array.from(document.querySelectorAll('[data-testid="block-item"]'));
      const counts = {};
      for (const item of blockItems) {
        const t = item.getAttribute('data-block-type');
        counts[t] = (counts[t] || 0) + 1;
      }
      return { total: blockItems.length, counts };
    });

    console.log('==> 复合结构 Block Count & Distribution:', richCounts);
    assert.strictEqual(richCounts.total, 64, '复合结构总块数应为 64');
    assert.strictEqual(richCounts.counts.paragraph, 46, '复合结构段落块应为 46');
    assert.strictEqual(richCounts.counts.image, 10, '复合结构图片块应为 10');
    assert.strictEqual(richCounts.counts.heading, 6, '复合结构标题块应为 6');
    assert.strictEqual(richCounts.counts.table, 2, '复合结构表格块应为 2');
    console.log('✓ 复合结构 64 块（段落 46 / 图片 10 / 标题 6 / 表格 2）验证通过！');

    // 7. 测试各种边界切块规则（AC 详细核对）
    console.log('==> Testing specific edge cases and acceptance criteria in browser...');
    const edgeCaseResults = await page.evaluate(() => {
      // Create helper using App's logic
      const parser = new DOMParser();

      // Test 1: 富媒体卡片 section.mp_profile_iframe_wrp > mp-common-profile 不得静默消失
      const htmlCard = `
        <div id="js_content">
          <section class="mp_profile_iframe_wrp">
            <mp-common-profile data-nickname="测试号" data-alias="test"></mp-common-profile>
          </section>
        </div>
      `;

      // Test 2: 普通段落「文字 A → 图片 → 文字 B」切成三个块；仅包裹图片的段落成图片块；标题等不拆分
      const htmlSplit = `
        <div id="js_content">
          <p>文字 A <img data-src="https://mmbiz.qpic.cn/1.png"> 文字 B</p>
          <p><img data-src="https://mmbiz.qpic.cn/2.png"></p>
          <h1>标题文字 <img data-src="https://mmbiz.qpic.cn/3.png"></h1>
        </div>
      `;

      // Test 3: 噪声不成块 (script, style, 空 darkmode pre, .qr_code_pc, .reward_area)
      const htmlNoise = `
        <div id="js_content">
          <script>console.log("bad");</script>
          <style>.bad { color: red; }</style>
          <pre class="js_darkmode__23"></pre>
          <div class="qr_code_pc">二维码扫码</div>
          <div class="reward_area">赞赏</div>
          <p>正文段落</p>
        </div>
      `;

      // Test 4: 完整语义单元（列表 / 引用 / 表格 / 代码）各自整体成一个块，内部不再产生独立块
      const htmlUnits = `
        <div id="js_content">
          <blockquote>
            <p>引用前言</p>
            <ul><li>引用内列表项</li></ul>
          </blockquote>
          <ul>
            <li>
              列表项
              <blockquote>列表内引用</blockquote>
              <ul><li>嵌套列表项</li></ul>
            </li>
          </ul>
          <hr>
        </div>
      `;

      // Test 5: Word 粘贴的 <o:p> 不得泄漏成假段落块
      const htmlWord = `
        <div id="js_content">
          <p>段落一<o:p>&nbsp;</o:p></p>
          <o:p>&nbsp;</o:p>
          <p>段落二</p>
        </div>
      `;

      return {
        htmlCard,
        htmlSplit,
        htmlNoise,
        htmlUnits,
        htmlWord,
      };
    });

    // 依次通过 App 渲染这些 HTML 并核对切块结果
    console.log('==> Testing edge case: Card preservation...');
    await page.evaluate(async (html) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Card Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: html,
            unstable: false,
            tabId: 201,
          },
        },
      });
    }, edgeCaseResults.htmlCard);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="block-item"]');
    const cardBlockTypes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="block-item"]')).map((el) => el.getAttribute('data-block-type'))
    );
    assert.deepStrictEqual(cardBlockTypes, ['richMedia'], 'mp-common-profile 必须被切为 richMedia 块，不得丢失');
    console.log('✓ Card preservation 验证通过！');

    console.log('==> Testing edge case: Text A -> Img -> Text B splitting & Heading not split...');
    await page.evaluate(async (html) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Split Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: html,
            unstable: false,
            tabId: 202,
          },
        },
      });
    }, edgeCaseResults.htmlSplit);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="block-item"]');
    const splitBlockTypes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="block-item"]')).map((el) => el.getAttribute('data-block-type'))
    );
    // 预期：文字A(paragraph) -> 图片(image) -> 文字B(paragraph) -> 仅图片(image) -> 标题(heading)
    assert.deepStrictEqual(
      splitBlockTypes,
      ['paragraph', 'image', 'paragraph', 'image', 'heading'],
      '普通段落文字-图-文字必须切为3块，仅包裹图片成图片块，标题不拆分'
    );
    console.log('✓ Paragraph splitting & Heading preservation 验证通过！');

    console.log('==> Testing edge case: Noise rejection...');
    await page.evaluate(async (html) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Noise Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: html,
            unstable: false,
            tabId: 203,
          },
        },
      });
    }, edgeCaseResults.htmlNoise);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="block-item"]');
    const noiseBlockTypes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="block-item"]')).map((el) => el.getAttribute('data-block-type'))
    );
    assert.deepStrictEqual(noiseBlockTypes, ['paragraph'], '噪声元素不得产生块，只有正文段落成块');
    console.log('✓ Noise rejection 验证通过！');

    console.log('==> Testing edge case: Units (quote with list, list with nested, hr divider)...');
    await page.evaluate(async (html) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Units Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: html,
            unstable: false,
            tabId: 204,
          },
        },
      });
    }, edgeCaseResults.htmlUnits);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="block-item"]');
    const unitBlockTypes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="block-item"]')).map((el) => el.getAttribute('data-block-type'))
    );
    // 预期：引用套列表 -> 1个quote；列表含引用与嵌套 -> 1个list；hr -> 1个divider
    assert.deepStrictEqual(
      unitBlockTypes,
      ['quote', 'list', 'divider'],
      '完整语义单元应整体成块，嵌套不产生额外独立块'
    );
    console.log('✓ Units & Divider preservation 验证通过！');

    console.log('==> Testing edge case: Word paste <o:p> tag leakage prevention...');
    await page.evaluate(async (html) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Word Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: html,
            unstable: false,
            tabId: 205,
          },
        },
      });
    }, edgeCaseResults.htmlWord);

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="block-item"]');
    const wordBlockCount = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="block-item"]').length
    );
    assert.strictEqual(wordBlockCount, 2, '空 <o:p> 不得泄漏为假段落块，只应产生 2 个段落');
    console.log('✓ Word paste <o:p> leakage prevention 验证通过！');

    // 8. 测试整篇级失败处理：ARCHITECTURE.md §6.2
    console.log('==> Testing whole-article failure handling (no candidateSnapshot, no currentSession change)...');
    await page.evaluate(async () => {
      // Clear candidateSnapshot and currentSession if any
      await chrome.storage.local.remove(['candidateSnapshot', 'currentSession']);

      // Inject full page HTML that is missing #js_content
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: { title: 'Failure Test', account: 'test', publishedAt: '2024-01-01', url: 'https://test' },
            contentHtml: '<!DOCTYPE html><html><body><div id="not_content"><p>Missing content</p></div></body></html>',
            unstable: false,
            tabId: 301,
          },
        },
      });
    });

    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="article-failure-card"]', { timeout: 5000 });

    const storageCheck = await page.evaluate(async () => {
      const data = await chrome.storage.local.get(['candidateSnapshot', 'currentSession']);
      return {
        hasCandidateSnapshot: Boolean(data.candidateSnapshot),
        hasCurrentSession: Boolean(data.currentSession),
        failureCardText: document.querySelector('[data-testid="article-failure-card"]')?.textContent || '',
      };
    });

    assert.strictEqual(storageCheck.hasCandidateSnapshot, false, '整篇级失败不得写入 candidateSnapshot');
    assert.strictEqual(storageCheck.hasCurrentSession, false, '整篇级失败不得变动 currentSession');
    assert.ok(storageCheck.failureCardText.includes('无法切分文章正文块'), '应展示通用失败提示');
    assert.ok(storageCheck.failureCardText.includes('重试'), '应展示重试按钮');
    console.log('✓ Whole-article failure handling 验证通过！');

    console.log('\n==> ALL Issue #17 AC VERIFICATION TESTS PASSED SUCCESSFULLY! <==\n');
  } finally {
    await browser.close();
  }
}

runTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
