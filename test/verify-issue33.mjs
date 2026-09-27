import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #33 Verification (Export Image Localization, Collection, Download & Path Rewriting)...');

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

    await page.evaluate(() => {
      const assertFn = function(condition, message) {
        if (!condition) {
          throw new Error(`Assertion failed: ${message || ''}`);
        }
      };
      assertFn.strictEqual = function(actual, expected, message) {
        if (actual !== expected) {
          throw new Error(`${message || 'Assertion failed'}: expected "${expected}", got "${actual}"`);
        }
      };
      assertFn.deepStrictEqual = function(actual, expected, message) {
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a !== e) {
          throw new Error(`${message || 'Assertion failed'}: expected ${e}, got ${a}`);
        }
      };
      assertFn.ok = assertFn;
      window.assert = assertFn;
    });

    // --------------------------------------------------------------------------
    // Test 2: collectExportImageReferences (AC 1, 2, 3, 4, 5, 6)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: collectExportImageReferences ---');
    await page.evaluate(() => {
      const { collectExportImageReferences } = window.__wetrim;
      assert(typeof collectExportImageReferences === 'function', 'collectExportImageReferences must be exposed');

      const md = [
        '# 标题含图 ![标题图](https://mmbiz.qpic.cn/title.png)',
        '',
        '段落含行内图 ![段落图](https://mmbiz.qpic.cn/inline.png?wx_fmt=png&size=large "行内标题")',
        '',
        '> 引用块含引用式图 ![引用图][ref1]',
        '',
        '- 列表含快捷引用 ![ref2]',
        '  - 嵌套列表含折叠引用 ![折叠图][ref3]',
        '',
        '| 表头 |',
        '| --- |',
        '| 表格内图片 ![表格图](https://mmbiz.qpic.cn/table.webp) |',
        '',
        '加粗样式 **![粗体图](https://mmbiz.qpic.cn/bold.jpg)** 与带链接图片 [![图链](https://mmbiz.qpic.cn/link-img.png)](https://example.com/target-page)',
        '',
        '相对路径图片 ![相对图](/static/rel.gif) 与尖括号图片 ![尖括号图](<https://mmbiz.qpic.cn/bracket.png>)',
        '',
        '重复出现的图（同一完整 URL）：![重复图](https://mmbiz.qpic.cn/title.png)',
        '![独立行首图](https://mmbiz.qpic.cn/standalone.png)',
        '重复出现的查询参数不同（视为不同图片）：![不同参数](https://mmbiz.qpic.cn/title.png?v=2)',
        '',
        '```js',
        '// 代码块内的假图片不当成图片',
        'const fake = "![代码图](https://mmbiz.qpic.cn/fake-code.png)";',
        '```',
        '',
        '行内代码 `![行内假图](https://mmbiz.qpic.cn/fake-inline.png)` 也不是图片。',
        '普通超链接 [普通链接](https://mmbiz.qpic.cn/not-an-image.html) 不触发图片下载。',
        '未定义的引用式图片 ![未定义][nonexistentRef] 不算有效图片引用。',
        '',
        '[ref1]: https://mmbiz.qpic.cn/ref1.jpg "Ref 1 Title"',
        '[ref2]: https://mmbiz.qpic.cn/ref2.gif',
        '[ref3]: https://mmbiz.qpic.cn/ref3.png'
      ].join('\n');

      const baseUrl = 'https://mp.weixin.qq.com/s/test-article';
      const refs = collectExportImageReferences(md, baseUrl);

      // 验证总共提取的有效且去重后的图片引用列表
      // 期望序列：
      // 1: title.png -> image-001
      // 2: inline.png -> image-002
      // 3: ref1.jpg -> image-003
      // 4: ref2.gif -> image-004
      // 5: ref3.png -> image-005
      // 6: table.webp -> image-006
      // 7: bold.jpg -> image-007
      // 8: link-img.png -> image-008
      // 9: /static/rel.gif (resolved to https://mp.weixin.qq.com/static/rel.gif) -> image-009
      // 10: bracket.png -> image-010
      // 11: standalone.png -> image-011
      // 12: title.png?v=2 -> image-012
      assert.strictEqual(refs.length, 12, `Expected 12 distinct valid image references, got ${refs.length}`);

      assert.strictEqual(refs[0].fileBaseName, 'image-001');
      assert.strictEqual(refs[0].resolvedUrl, 'https://mmbiz.qpic.cn/title.png');
      assert.strictEqual(refs[0].alt, '标题图');

      assert.strictEqual(refs[1].fileBaseName, 'image-002');
      assert.strictEqual(refs[1].resolvedUrl, 'https://mmbiz.qpic.cn/inline.png?wx_fmt=png&size=large');
      assert.strictEqual(refs[1].alt, '段落图');
      assert.strictEqual(refs[1].title, '行内标题');

      assert.strictEqual(refs[2].fileBaseName, 'image-003');
      assert.strictEqual(refs[2].resolvedUrl, 'https://mmbiz.qpic.cn/ref1.jpg');
      assert.strictEqual(refs[2].alt, '引用图');
      assert.strictEqual(refs[2].title, 'Ref 1 Title');

      assert.strictEqual(refs[3].fileBaseName, 'image-004');
      assert.strictEqual(refs[3].resolvedUrl, 'https://mmbiz.qpic.cn/ref2.gif');

      assert.strictEqual(refs[4].fileBaseName, 'image-005');
      assert.strictEqual(refs[4].resolvedUrl, 'https://mmbiz.qpic.cn/ref3.png');

      assert.strictEqual(refs[5].fileBaseName, 'image-006');
      assert.strictEqual(refs[5].resolvedUrl, 'https://mmbiz.qpic.cn/table.webp');

      assert.strictEqual(refs[6].fileBaseName, 'image-007');
      assert.strictEqual(refs[6].resolvedUrl, 'https://mmbiz.qpic.cn/bold.jpg');

      assert.strictEqual(refs[7].fileBaseName, 'image-008');
      assert.strictEqual(refs[7].resolvedUrl, 'https://mmbiz.qpic.cn/link-img.png');

      // 验证相对地址被正确解析为绝对地址
      assert.strictEqual(refs[8].fileBaseName, 'image-009');
      assert.strictEqual(refs[8].resolvedUrl, 'https://mp.weixin.qq.com/static/rel.gif');

      // 验证尖括号被去除，括号外不留尖括号
      assert.strictEqual(refs[9].fileBaseName, 'image-010');
      assert.strictEqual(refs[9].resolvedUrl, 'https://mmbiz.qpic.cn/bracket.png');

      // 验证行首独立图片收集
      assert.strictEqual(refs[10].fileBaseName, 'image-011');
      assert.strictEqual(refs[10].resolvedUrl, 'https://mmbiz.qpic.cn/standalone.png');
      assert.strictEqual(refs[10].alt, '独立行首图');

      // 验证保留查询参数且不同参数不合并
      assert.strictEqual(refs[11].fileBaseName, 'image-012');
      assert.strictEqual(refs[11].resolvedUrl, 'https://mmbiz.qpic.cn/title.png?v=2');

      // 验证超过 999 时自然增长（image-1000 等）
      const { formatImageBaseName } = window.__wetrim;
      assert.strictEqual(formatImageBaseName(1), 'image-001');
      assert.strictEqual(formatImageBaseName(99), 'image-099');
      assert.strictEqual(formatImageBaseName(999), 'image-999');
      assert.strictEqual(formatImageBaseName(1000), 'image-1000');
      assert.strictEqual(formatImageBaseName(12345), 'image-12345');
    });
    console.log('✓ Test 2 Passed: collectExportImageReferences conforms to all AC 1, 2, 3, 4, 5, 6 specifications');

    // --------------------------------------------------------------------------
    // Test 3: detectImageFormat & fetchAllExportImages (AC 5, 7, 8, 10, 11)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: detectImageFormat & fetchAllExportImages ---');
    await page.evaluate(async () => {
      const { detectImageFormat, fetchAllExportImages } = window.__wetrim;
      assert(typeof detectImageFormat === 'function', 'detectImageFormat must be exposed');
      assert(typeof fetchAllExportImages === 'function', 'fetchAllExportImages must be exposed');

      // 3.1 媒体格式魔数识别
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      assert.strictEqual(detectImageFormat(pngBytes)?.format, 'png');
      assert.strictEqual(detectImageFormat(pngBytes)?.extension, '.png');

      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      assert.strictEqual(detectImageFormat(jpegBytes)?.format, 'jpeg');
      assert.strictEqual(detectImageFormat(jpegBytes)?.extension, '.jpg');

      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);
      assert.strictEqual(detectImageFormat(gifBytes)?.format, 'gif');
      assert.strictEqual(detectImageFormat(gifBytes)?.extension, '.gif');

      const webpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
      ]);
      assert.strictEqual(detectImageFormat(webpBytes)?.format, 'webp');
      assert.strictEqual(detectImageFormat(webpBytes)?.extension, '.webp');

      const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>');
      assert.strictEqual(detectImageFormat(svgBytes)?.format, 'svg');
      assert.strictEqual(detectImageFormat(svgBytes)?.extension, '.svg');

      const svgDoctypeBytes = new TextEncoder().encode(
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>'
      );
      assert.strictEqual(detectImageFormat(svgDoctypeBytes)?.format, 'svg');
      assert.strictEqual(detectImageFormat(svgDoctypeBytes)?.extension, '.svg');

      // 非受支持数据：HTML 错误页、JSON 或损坏二进制
      const htmlBytes = new TextEncoder().encode('<!DOCTYPE html><html><body>Error 404</body></html>');
      assert.strictEqual(detectImageFormat(htmlBytes), null, 'HTML error page must return null');

      const jsonBytes = new TextEncoder().encode('{"error": "not found"}');
      assert.strictEqual(detectImageFormat(jsonBytes), null, 'JSON response must return null');

      const corruptBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      assert.strictEqual(detectImageFormat(corruptBytes), null, 'Random binary must return null');

      // 3.2 真实与 Mock 抓取逻辑
      // 准备 4 个测试条目：
      // 条目 1：URL 伪装成 .jpg，实际返回 PNG 字节 -> 必须判定为 .png（不能只凭 URL 后缀或固定 .jpg）
      // 条目 2：返回 200 HTML 错误页 -> 必须判定为下载失败，不伪装成图片
      // 条目 3：返回 403 权限错误 -> 判定为下载失败
      // 条目 4：WebP 格式图片 -> 保持 .webp，编号保持 004（不因中间失败而向前重排）
      const testRefs = [
        {
          index: 1,
          fileBaseName: 'image-001',
          rawUrl: 'https://example.com/fake.jpg',
          resolvedUrl: 'https://example.com/fake.jpg',
          alt: '图1',
        },
        {
          index: 2,
          fileBaseName: 'image-002',
          rawUrl: 'https://example.com/error-page.png',
          resolvedUrl: 'https://example.com/error-page.png',
          alt: '图2',
        },
        {
          index: 3,
          fileBaseName: 'image-003',
          rawUrl: 'https://example.com/forbidden.png',
          resolvedUrl: 'https://example.com/forbidden.png',
          alt: '图3',
        },
        {
          index: 4,
          fileBaseName: 'image-004',
          rawUrl: 'https://example.com/real.webp',
          resolvedUrl: 'https://example.com/real.webp',
          alt: '图4',
        },
      ];

      const progressHistory = [];
      const mockFetch = async (url) => {
        if (url === 'https://example.com/fake.jpg') {
          // 真实内容是 PNG（100 字节）
          const data = new Uint8Array(100);
          data.set(pngBytes, 0);
          return new Response(data, {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' }, // Content-Type 甚至是假的，全靠魔数识别
          });
        }
        if (url === 'https://example.com/error-page.png') {
          return new Response('<html><head><title>404 Not Found</title></head></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (url === 'https://example.com/forbidden.png') {
          return new Response('Forbidden', { status: 403 });
        }
        if (url === 'https://example.com/real.webp') {
          const data = new Uint8Array(50);
          data.set(webpBytes, 0);
          return new Response(data, {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
          });
        }
        throw new Error(`Unexpected mock URL: ${url}`);
      };

      const result = await fetchAllExportImages(testRefs, {
        fetchFn: mockFetch,
        onProgress: (p) => {
          progressHistory.push({ ...p });
        },
      });

      // 验证成功与失败条数
      assert.strictEqual(result.succeeded.length, 2);
      assert.strictEqual(result.failed.length, 2);

      // 验证实际扩展名（PNG 与 WebP）与文件名（图4保持 image-004，不要求下载失败后连续）
      const item1 = result.succeeded.find((s) => s.url === 'https://example.com/fake.jpg');
      assert.ok(item1);
      assert.strictEqual(item1.format, 'png');
      assert.strictEqual(item1.extension, '.png');
      assert.strictEqual(item1.fileName, 'image-001.png');

      const item4 = result.succeeded.find((s) => s.url === 'https://example.com/real.webp');
      assert.ok(item4);
      assert.strictEqual(item4.format, 'webp');
      assert.strictEqual(item4.extension, '.webp');
      assert.strictEqual(item4.fileName, 'image-004.webp');

      // 验证失败项
      const fail2 = result.failed.find((f) => f.url === 'https://example.com/error-page.png');
      assert.ok(fail2);

      const fail3 = result.failed.find((f) => f.url === 'https://example.com/forbidden.png');
      assert.ok(fail3);

      // 验证映射表
      assert.strictEqual(result.urlToRelativePathMap.get('https://example.com/fake.jpg'), 'images/image-001.png');
      assert.strictEqual(result.urlToRelativePathMap.get('https://example.com/real.webp'), 'images/image-004.webp');
      assert.strictEqual(result.urlToRelativePathMap.has('https://example.com/error-page.png'), false);
      assert.strictEqual(result.urlToRelativePathMap.has('https://example.com/forbidden.png'), false);

      // 验证进度反馈（按下载字节计量，且包含累计字节）
      assert.ok(progressHistory.length >= 4);
      const lastProgress = progressHistory[progressHistory.length - 1];
      assert.strictEqual(lastProgress.downloadedBytes, 150); // 100 + 50
      assert.strictEqual(lastProgress.completedCount, 4);
      assert.strictEqual(lastProgress.totalCount, 4);
    });
    console.log('✓ Test 3 Passed: detectImageFormat & fetchAllExportImages conform to all AC 5, 7, 8, 10, 11 specifications');

    // --------------------------------------------------------------------------
    // Test 4: rewriteMarkdownImagePaths (AC 1, 2, 3, 9, 12)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: rewriteMarkdownImagePaths ---');
    await page.evaluate(() => {
      const { rewriteMarkdownImagePaths } = window.__wetrim;
      assert(typeof rewriteMarkdownImagePaths === 'function', 'rewriteMarkdownImagePaths must be exposed');

      const originalMd = [
        '---',
        'title: "标题测试"',
        'account: "公众号名称"',
        'date: 2026-09-26',
        'source: "https://mp.weixin.qq.com/s/test-src"',
        '---',
        '',
        '# 标题含图 ![标题图](https://mmbiz.qpic.cn/title.png)',
        '',
        '段落含行内图 ![段落图](https://mmbiz.qpic.cn/inline.png?wx_fmt=png&size=large "行内标题") 与未本地化外链 ![失败图](https://example.com/failed.png)',
        '',
        '> 引用块含引用式图 ![引用图][ref1]',
        '',
        '- 列表含快捷引用 ![ref2]',
        '',
        '| 表头 |',
        '| --- |',
        '| 表格内图片 ![表格图](<https://mmbiz.qpic.cn/table.webp>) |',
        '',
        '![独立行首图](https://mmbiz.qpic.cn/standalone.png)',
        '',
        '带超链接的图片 [![嵌套图链](https://mmbiz.qpic.cn/link.png)](https://example.com/target-page)',
        '',
        '重复出现的图（同一完整 URL）：![重复图](https://mmbiz.qpic.cn/title.png)',
        '',
        '```js',
        '// 代码块内的假图片绝不能被改写',
        'const fakeImg = "![代码假图](https://mmbiz.qpic.cn/title.png)";',
        'const fakeRef = "[ref1]: https://mmbiz.qpic.cn/ref1.jpg";',
        '```',
        '',
        '行内代码 `![行内假图](https://mmbiz.qpic.cn/title.png)` 绝不能被改写。',
        '普通超链接 [链接至同图](https://mmbiz.qpic.cn/title.png) 绝不能被改写。',
        '正文裸写 URL https://mmbiz.qpic.cn/title.png 绝不能被改写。',
        '',
        '[ref1]: https://mmbiz.qpic.cn/ref1.jpg "Ref 1 Title"',
        '[ref2]: https://mmbiz.qpic.cn/ref2.gif',
        '[ref_failed]: https://example.com/unlocalized.jpg'
      ].join('\n');

      const localizedMap = new Map([
        ['https://mmbiz.qpic.cn/title.png', 'images/image-001.png'],
        ['https://mmbiz.qpic.cn/inline.png?wx_fmt=png&size=large', 'images/image-002.png'],
        ['https://mmbiz.qpic.cn/ref1.jpg', 'images/image-003.jpg'],
        ['https://mmbiz.qpic.cn/ref2.gif', 'images/image-004.gif'],
        ['https://mmbiz.qpic.cn/table.webp', 'images/image-005.webp'],
        ['https://mmbiz.qpic.cn/standalone.png', 'images/image-006.png'],
        ['https://mmbiz.qpic.cn/link.png', 'images/image-007.png'],
      ]);

      const rewritten = rewriteMarkdownImagePaths(originalMd, localizedMap);

      // 验证改写结果的每一处预期的替换：
      // 1. 标题图改写为 images/image-001.png
      assert(rewritten.includes('![标题图](images/image-001.png)'));

      // 2. 段落图改写并保留替代文字与标题
      assert(rewritten.includes('![段落图](images/image-002.png "行内标题")'));

      // 3. 失败的图片未在映射中，原样保留外链
      assert(rewritten.includes('![失败图](https://example.com/failed.png)'));

      // 4. 引用式图片保留标签 ![引用图][ref1]，其底部定义被改写
      assert(rewritten.includes('![引用图][ref1]'));
      assert(rewritten.includes('[ref1]: images/image-003.jpg "Ref 1 Title"'));

      // 5. 快捷引用定义被改写
      assert(rewritten.includes('![ref2]'));
      assert(rewritten.includes('[ref2]: images/image-004.gif'));
      assert(rewritten.includes('[ref_failed]: https://example.com/unlocalized.jpg'));

      // 6. 行首独立图片改写
      assert(rewritten.includes('![独立行首图](images/image-006.png)'));

      // 7. 带超链接的图片改写，外层超链接完好无损
      assert(rewritten.includes('[![嵌套图链](images/image-007.png)](https://example.com/target-page)'));

      // 6. 表格内尖括号包裹的图片改写，保留尖括号
      assert(rewritten.includes('![表格图](<images/image-005.webp>)'));

      // 7. 重复图指向同一个本地文件
      assert(rewritten.includes('![重复图](images/image-001.png)'));

      // 8. 必须保护的代码块、行内代码、普通超链接、普通文本
      assert(rewritten.includes('const fakeImg = "![代码假图](https://mmbiz.qpic.cn/title.png)";'));
      assert(rewritten.includes('const fakeRef = "[ref1]: https://mmbiz.qpic.cn/ref1.jpg";'));
      assert(rewritten.includes('`![行内假图](https://mmbiz.qpic.cn/title.png)`'));
      assert(rewritten.includes('[链接至同图](https://mmbiz.qpic.cn/title.png)'));
      assert(rewritten.includes('正文裸写 URL https://mmbiz.qpic.cn/title.png 绝不能被改写。'));

      // 9. YAML front-matter 必须完全未受影响
      assert(rewritten.startsWith('---\ntitle: "标题测试"\naccount: "公众号名称"\ndate: 2026-09-26\nsource: "https://mp.weixin.qq.com/s/test-src"\n---'));

      // 10. AC 12 核心承诺：除成功本地化的图片 URL 映射为 images/… 外，其余文本逐字一致
      // 反向将 images/image-xxx 逆向替换回原 URL 后，必须与 originalMd 100% 逐字相同
      let reverted = rewritten;
      reverted = reverted.replaceAll('images/image-001.png', 'https://mmbiz.qpic.cn/title.png');
      reverted = reverted.replaceAll('images/image-002.png', 'https://mmbiz.qpic.cn/inline.png?wx_fmt=png&size=large');
      reverted = reverted.replaceAll('images/image-003.jpg', 'https://mmbiz.qpic.cn/ref1.jpg');
      reverted = reverted.replaceAll('images/image-004.gif', 'https://mmbiz.qpic.cn/ref2.gif');
      reverted = reverted.replaceAll('images/image-005.webp', 'https://mmbiz.qpic.cn/table.webp');
      reverted = reverted.replaceAll('images/image-006.png', 'https://mmbiz.qpic.cn/standalone.png');
      reverted = reverted.replaceAll('images/image-007.png', 'https://mmbiz.qpic.cn/link.png');
      assert.strictEqual(reverted, originalMd, 'Reverted markdown must be 100% character-by-character identical to originalMd');
    });
    console.log('✓ Test 4 Passed: rewriteMarkdownImagePaths conforms to all AC 1, 2, 3, 9, 12 specifications');

    // --------------------------------------------------------------------------
    // Test 5: writeArticleDirectory Integration with Images (AC 1, 2, 3, 5, 6, 7, 9, 10, 12)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: writeArticleDirectory Integration with Images ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory } = window.__wetrim;
      assert(typeof writeArticleDirectory === 'function');
      const rootDir = await navigator.storage.getDirectory();

      // 清理测试目录
      for await (const name of rootDir.keys()) {
        try {
          await rootDir.removeEntry(name, { recursive: true });
        } catch {}
      }

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
      const webpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
      ]);

      const mockFetch = async (url) => {
        if (url === 'https://mmbiz.qpic.cn/p1.png') {
          return new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
        }
        if (url === 'https://mmbiz.qpic.cn/p2.webp') {
          return new Response(webpBytes, { status: 200, headers: { 'Content-Type': 'image/webp' } });
        }
        if (url === 'https://example.com/fail.png') {
          return new Response('Not Found', { status: 404 });
        }
        throw new Error(`Unexpected URL in mock: ${url}`);
      };

      const snapshot = {
        source: {
          title: '图片本地化实测文章',
          account: '测试号',
          publishedAt: '2026-09-26 10:00:00',
          url: 'https://mp.weixin.qq.com/s/sample-img',
        },
        blocks: [
          {
            id: 'b1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>第一段</p>',
            initialMarkdown: '第一段含图片 ![图1](https://mmbiz.qpic.cn/p1.png)',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b2',
            order: 2,
            type: 'list',
            originalHtml: '<ul><li>列表</li></ul>',
            initialMarkdown: '- 列表含快捷引用 ![ref1]\n\n[ref1]: https://mmbiz.qpic.cn/p2.webp "P2 Title"',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b3',
            order: 3,
            type: 'quote',
            originalHtml: '<blockquote>引用</blockquote>',
            initialMarkdown: '> 引用块含重复图 ![图1 副本](https://mmbiz.qpic.cn/p1.png)',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b4',
            order: 4,
            type: 'code',
            originalHtml: '<pre><code>代码</code></pre>',
            initialMarkdown: '```js\nconst fake = "![fake](https://mmbiz.qpic.cn/p1.png)";\n```',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b5',
            order: 5,
            type: 'paragraph',
            originalHtml: '<p>下载失败段</p>',
            initialMarkdown: '这段包含下载失败的图片 ![失败图](https://example.com/fail.png)',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b6',
            order: 6,
            type: 'paragraph',
            originalHtml: '<p>已被剔除的段落</p>',
            initialMarkdown: '剔除段含图 ![剔除图](https://mmbiz.qpic.cn/excluded.png)',
            editedMarkdown: null,
            included: false, // 剔除状态！绝不能被收集和下载！
            notes: [],
          },
        ],
      };

      const res = await writeArticleDirectory(rootDir, snapshot, {
        fetchFn: mockFetch,
      });

      assert.strictEqual(res.ok, true, 'writeArticleDirectory should return ok: true');
      assert.strictEqual(res.articleDirName, '图片本地化实测文章');
      assert.strictEqual(res.markdownFileName, '图片本地化实测文章.md');

      // 验证外层文章目录存在
      const articleDir = await rootDir.getDirectoryHandle('图片本地化实测文章', { create: false });
      assert.ok(articleDir);

      // 验证 images/ 目录存在
      const imagesDir = await articleDir.getDirectoryHandle('images', { create: false });
      assert.ok(imagesDir);

      // 验证本地图片文件已正确写入
      const img1Handle = await imagesDir.getFileHandle('image-001.png', { create: false });
      const img1File = await img1Handle.getFile();
      const img1Bytes = new Uint8Array(await img1File.arrayBuffer());
      assert.strictEqual(img1Bytes.length, pngBytes.length);
      assert.strictEqual(img1Bytes[0], 0x89);

      const img2Handle = await imagesDir.getFileHandle('image-002.webp', { create: false });
      const img2File = await img2Handle.getFile();
      const img2Bytes = new Uint8Array(await img2File.arrayBuffer());
      assert.strictEqual(img2Bytes.length, webpBytes.length);
      assert.strictEqual(img2Bytes[0], 0x52);

      // 验证被剔除的块中的图片没有被写入
      let excludedFound = false;
      try {
        await imagesDir.getFileHandle('image-003.png', { create: false });
        excludedFound = true;
      } catch {}
      assert.strictEqual(excludedFound, false, 'Excluded block image must NOT be downloaded or saved');

      // 验证写入的 Markdown 文件内容与路径改写
      const mdHandle = await articleDir.getFileHandle('图片本地化实测文章.md', { create: false });
      const mdFile = await mdHandle.getFile();
      const mdContent = await mdFile.text();

      assert(mdContent.includes('![图1](images/image-001.png)'), 'Image 1 must be rewritten to images/image-001.png');
      assert(mdContent.includes('![图1 副本](images/image-001.png)'), 'Duplicate image must point to same file');
      assert(mdContent.includes('![ref1]'), 'Reference image tag must be preserved');
      assert(mdContent.includes('[ref1]: images/image-002.webp "P2 Title"'), 'Reference definition must be rewritten to images/image-002.webp with title preserved');
      assert(mdContent.includes('const fake = "![fake](https://mmbiz.qpic.cn/p1.png)";'), 'Code block must remain verbatim untouched');
      assert(mdContent.includes('![失败图](https://example.com/fail.png)'), 'Failed image must remain external URL');
      assert(!mdContent.includes('剔除段含图'), 'Excluded block content must not appear in output');

      // 验收标准：不回写清洗会话的当前内容
      assert.strictEqual(snapshot.blocks[0].initialMarkdown, '第一段含图片 ![图1](https://mmbiz.qpic.cn/p1.png)');
      assert.strictEqual(snapshot.blocks[0].editedMarkdown, null);
    });
    console.log('✓ Test 5 Passed: writeArticleDirectory integration with images verified');

    // --------------------------------------------------------------------------
    // Test 6: No local images -> no images/ directory created (AC: 没有本地图片时不创建 images/)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: No local images -> no images/ directory created ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();

      const snapshotNoImages = {
        source: {
          title: '纯文本文章无图',
          account: '测试号',
          publishedAt: '2026-09-26 10:00:00',
          url: 'https://mp.weixin.qq.com/s/pure-text',
        },
        blocks: [
          {
            id: 't1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>纯文本段落</p>',
            initialMarkdown: '这里没有任何图片。',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
        ],
      };

      const res = await writeArticleDirectory(rootDir, snapshotNoImages);
      assert.strictEqual(res.ok, true);

      const articleDir = await rootDir.getDirectoryHandle('纯文本文章无图', { create: false });
      let imagesCreated = false;
      try {
        await articleDir.getDirectoryHandle('images', { create: false });
        imagesCreated = true;
      } catch {}
      assert.strictEqual(imagesCreated, false, 'images/ directory must NOT be created when no images exist');
    });
    console.log('✓ Test 6 Passed: No images/ created for text-only article');

    // --------------------------------------------------------------------------
    // Test 7: All image downloads fail -> no images/ directory created
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: All image downloads fail -> no images/ directory created ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();

      const snapshotFailedImages = {
        source: {
          title: '全部下载失败文章',
          account: '测试号',
          publishedAt: '2026-09-26 10:00:00',
          url: 'https://mp.weixin.qq.com/s/all-fail',
        },
        blocks: [
          {
            id: 'f1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>图</p>',
            initialMarkdown: '![图A](https://example.com/404-a.png) ![图B](https://example.com/404-b.png)',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
        ],
      };

      const mockAllFail = async () => new Response('404', { status: 404 });

      const res = await writeArticleDirectory(rootDir, snapshotFailedImages, {
        fetchFn: mockAllFail,
      });
      assert.strictEqual(res.ok, true);

      const articleDir = await rootDir.getDirectoryHandle('全部下载失败文章', { create: false });
      let imagesCreated = false;
      try {
        await articleDir.getDirectoryHandle('images', { create: false });
        imagesCreated = true;
      } catch {}
      assert.strictEqual(imagesCreated, false, 'images/ directory must NOT be created when all image downloads fail');

      const mdFile = await (await articleDir.getFileHandle('全部下载失败文章.md', { create: false })).getFile();
      const content = await mdFile.text();
      assert(content.includes('![图A](https://example.com/404-a.png)'));
      assert(content.includes('![图B](https://example.com/404-b.png)'));
    });
    console.log('✓ Test 7 Passed: No images/ created when all downloads fail');

    // --------------------------------------------------------------------------
    // Test 8: AC 4 (Delete last reference vs. another block still referencing it)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Delete last reference vs. another block still referencing it (AC 4) ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      const mockFetch = async () => new Response(pngBytes, { status: 200 });

      // 场景 A: 块 1 与 块 2 引用同一张图，块 1 被剔除，但块 2 保留 -> 图片仍需导出
      const snapshotShared = {
        source: {
          title: '共享图片测试A',
          account: '测试号',
          publishedAt: '2026-09-26 10:00:00',
          url: 'https://mp.weixin.qq.com/s/shared-a',
        },
        blocks: [
          {
            id: 's1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>块1</p>',
            initialMarkdown: '块1 ![同图](https://mmbiz.qpic.cn/shared.png)',
            editedMarkdown: null,
            included: false, // 块 1 剔除
            notes: [],
          },
          {
            id: 's2',
            order: 2,
            type: 'paragraph',
            originalHtml: '<p>块2</p>',
            initialMarkdown: '块2 仍在引用 ![同图](https://mmbiz.qpic.cn/shared.png)',
            editedMarkdown: null,
            included: true, // 块 2 保留
            notes: [],
          },
        ],
      };

      const resA = await writeArticleDirectory(rootDir, snapshotShared, { fetchFn: mockFetch });
      assert.strictEqual(resA.ok, true);
      const articleDirA = await rootDir.getDirectoryHandle('共享图片测试A', { create: false });
      const imagesDirA = await articleDirA.getDirectoryHandle('images', { create: false });
      assert.ok(await imagesDirA.getFileHandle('image-001.png', { create: false }), 'Shared image must still be exported when another block references it');

      // 场景 B: 删掉最后一个保留引用（块 1 和 块 2 均剔除，或用户编辑清空了引用） -> 图片不再进入导出
      const snapshotRemoved = {
        source: {
          title: '共享图片测试B',
          account: '测试号',
          publishedAt: '2026-09-26 10:00:00',
          url: 'https://mp.weixin.qq.com/s/shared-b',
        },
        blocks: [
          {
            id: 's1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>块1</p>',
            initialMarkdown: '块1 ![同图](https://mmbiz.qpic.cn/shared.png)',
            editedMarkdown: null,
            included: false, // 块 1 剔除
            notes: [],
          },
          {
            id: 's2',
            order: 2,
            type: 'paragraph',
            originalHtml: '<p>块2</p>',
            initialMarkdown: '块2 用户编辑删掉了图片引用',
            editedMarkdown: '块2 纯文字编辑无图', // 用户编辑移除了引用
            included: true,
            notes: [],
          },
        ],
      };

      const resB = await writeArticleDirectory(rootDir, snapshotRemoved, { fetchFn: mockFetch });
      assert.strictEqual(resB.ok, true);
      const articleDirB = await rootDir.getDirectoryHandle('共享图片测试B', { create: false });
      let imagesCreatedB = false;
      try {
        await articleDirB.getDirectoryHandle('images', { create: false });
        imagesCreatedB = true;
      } catch {}
      assert.strictEqual(imagesCreatedB, false, 'No images should be exported after last reference is deleted');
    });
    console.log('✓ Test 8 Passed: AC 4 (Delete last reference vs. another block still referencing it) verified');

    // --------------------------------------------------------------------------
    // Test 9: Preview "Markdown 源码" vs. Exported .md byte-for-byte comparison (AC 12 & 自 #31 移交)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Preview "Markdown 源码" vs. Exported .md (AC 12 & 自 #31 移交) ---');
    await page.evaluate(async () => {
      const rootDir = await navigator.storage.getDirectory();

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99]);
      const mockFetch = async () => new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } });

      const testSnapshot = {
        snapshotId: 'snap-compare-31',
        capturedAt: '2026-09-26T12:00:00.000Z',
        source: {
          title: '预览与导出一致性对照实测',
          account: '微信对照测试号',
          publishedAt: '2026-09-26 15:30:00',
          url: 'https://mp.weixin.qq.com/s/compare-article',
        },
        blocks: [
          {
            id: 'c1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>引言段落</p>',
            initialMarkdown: '## 一级章节\n\n引言含图 ![第一张图](https://mmbiz.qpic.cn/c1.png "第一张图标题")。',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'c2',
            order: 2,
            type: 'code',
            originalHtml: '<pre><code>const a = 1;</code></pre>',
            initialMarkdown: '```python\n# 代码块中的假图片绝不能被改写\nimg = "![fake](https://mmbiz.qpic.cn/c1.png)"\n```',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'c3',
            order: 3,
            type: 'paragraph',
            originalHtml: '<p>引用定义段</p>',
            initialMarkdown: '使用引用式图片：![引用图标识][c_ref]\n\n[c_ref]: https://mmbiz.qpic.cn/c2.png "引用图标题"',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
        ],
        images: [],
        captureWarnings: [],
      };

      // 1. 载入会话
      window.__wetrim.dispatch({
        type: 'INIT_STORAGE_STATE',
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: 'sess-compare-31',
            revision: 1,
            savedAt: new Date().toISOString(),
            snapshot: testSnapshot,
          },
          candidateSnapshot: null,
          corrupted: false,
          isReadOnly: false,
        },
      });
    });

    // 等待块列表渲染完成
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="block-item"]').length === 3, {
      timeout: 3000,
    });

    // 2. 点击工具栏「检查结果」打开预览
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    // 点击切到「Markdown 源码」标签
    await page.click('[data-testid="preview-tab-source"]');
    await page.waitForSelector('[data-testid="preview-source-pre"]', { timeout: 3000 });

    // 获取预览「Markdown 源码」视图展示的完整源码文本
    const previewSourceText = await page.$eval('[data-testid="preview-source-pre"]', (el) => el.textContent);
    assert.ok(previewSourceText, 'Preview source view must have non-empty text');

    // 关闭预览弹窗
    await page.click('[data-testid="preview-btn-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="preview-dialog"]')?.hasAttribute('open'));

    // 3. 执行导出
    const exportResult = await page.evaluate(async () => {
      const { performExport, getState } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();
      const currentSnap = getState().session.snapshot;

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99]);
      const mockFetch = async () => new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } });

      return await performExport(currentSnap, undefined, {
        parentHandle: rootDir,
        fetchFn: mockFetch,
      });
    });

    assert.strictEqual(exportResult.ok, true, 'performExport should succeed');

    // 4. 等待导出成功反馈弹窗并关闭
    await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 3000 });
    const successTitle = await page.$eval('[data-testid="export-dialog-title"]', (el) => el.textContent);
    assert.strictEqual(successTitle, '导出完成');
    await page.click('[data-testid="export-dialog-btn-close"]');

    // 5. 读取实际导出的 Markdown 文件内容
    const exportedMdText = await page.evaluate(async () => {
      const rootDir = await navigator.storage.getDirectory();
      const articleDir = await rootDir.getDirectoryHandle('预览与导出一致性对照实测', { create: false });
      const mdFile = await (await articleDir.getFileHandle('预览与导出一致性对照实测.md', { create: false })).getFile();
      return await mdFile.text();
    });

    // 6. 严密对照 AC 12：
    // 导出的 .md 与同一时刻检查结果预览（#31）「Markdown 源码」视图的唯一差异是成功本地化的图片 URL 被改写为 images/… 相对路径，其余文本逐字一致（自 #31 移交）
    assert(exportedMdText.includes('![第一张图](images/image-001.png "第一张图标题")'));
    assert(exportedMdText.includes('![引用图标识][c_ref]'));
    assert(exportedMdText.includes('[c_ref]: images/image-002.png "引用图标题"'));

    let revertedExport = exportedMdText;
    revertedExport = revertedExport.replaceAll('images/image-001.png', 'https://mmbiz.qpic.cn/c1.png');
    revertedExport = revertedExport.replaceAll('images/image-002.png', 'https://mmbiz.qpic.cn/c2.png');

    assert.strictEqual(
      revertedExport,
      previewSourceText,
      'Exported .md reverted of images/... must match preview source text 100% byte-for-byte'
    );
    console.log('✓ Test 9 Passed: AC 12 transferred from #31 verified (preview source vs. export .md byte-for-byte consistent)');

    console.log('\n=============================================');
    console.log('✓ All Issue #33 verification tests passed!');
    console.log('=============================================');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
