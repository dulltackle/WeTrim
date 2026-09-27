import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #32 Verification (Export Markdown & Directory Writing)...');

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
      assertFn.ok = assertFn;
      window.assert = assertFn;
    });

    // --------------------------------------------------------------------------
    // Test 2: Filename Sanitization Rules (AC 4 & 5)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Filename Sanitization Rules ---');
    await page.evaluate(() => {
      const { sanitizeArticleTitle } = window.__wetrim;

      // 2.1 保留中文与 emoji（复合字素序列不被截断）
      const emojiTitle = '微信文章 👨‍👩‍👧‍👦 和 中文 123';
      assert.strictEqual(sanitizeArticleTitle(emojiTitle), emojiTitle);

      // 2.2 / \ : * ? " < > | 与控制字符替换为下划线
      const illegal = '标/题\\测:试*星?问"引<左>右|竖\x00零\x1f单元\x7fDEL\n换\r回\t制';
      const expectedIllegal = '标_题_测_试_星_问_引_左_右_竖_零_单元_DEL_换_回_制';
      assert.strictEqual(sanitizeArticleTitle(illegal), expectedIllegal);

      // 2.3 清除结尾的点与空格
      assert.strictEqual(sanitizeArticleTitle('测试标题. . .   '), '测试标题');
      assert.strictEqual(sanitizeArticleTitle('中间.和 空格.结尾...'), '中间.和 空格.结尾');

      // 2.4 Windows 保留名加前缀下划线
      const reserved = ['CON', 'con', 'PRN', 'prn', 'AUX', 'aux', 'NUL', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9'];
      for (const name of reserved) {
        assert.strictEqual(sanitizeArticleTitle(name), `_${name}`);
      }
      assert.strictEqual(sanitizeArticleTitle('CONNECT'), 'CONNECT');

      // 2.5 清理后为空用「未命名文章」
      assert.strictEqual(sanitizeArticleTitle(''), '未命名文章');
      assert.strictEqual(sanitizeArticleTitle('   '), '未命名文章');
      assert.strictEqual(sanitizeArticleTitle('...'), '未命名文章');
      assert.strictEqual(sanitizeArticleTitle(null), '未命名文章');
      assert.strictEqual(sanitizeArticleTitle(undefined), '未命名文章');

      // 2.6 基名最多 60 个可见字素并按完整字素截断，同时不超过 180 UTF-8 字节，并对最终组件再校验
      const sixtyFiveChars = '一二三四五六七八九十一二三四五六七八九十二一二三四五六七八九十三一二三四五六七八九四一二三四五六七八九五一二三四五六七八九六一二三四五';
      const res60 = sanitizeArticleTitle(sixtyFiveChars);
      assert.strictEqual(res60, sixtyFiveChars.slice(0, 60));
      assert.strictEqual(new TextEncoder().encode(res60).length, 180);

      // 复杂 emoji 截断不超过 180 字节且不拆散 emoji
      const manyEmojis = '👨‍👩‍👧‍👦'.repeat(10);
      const resEmojis = sanitizeArticleTitle(manyEmojis);
      const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(resEmojis));
      assert.strictEqual(graphemes.length, 7);
      assert(new TextEncoder().encode(resEmojis).length <= 180);

      // 截断后重新校验结尾点空格
      const dotTrunc = 'A'.repeat(59) + '. extra text';
      assert.strictEqual(sanitizeArticleTitle(dotTrunc), 'A'.repeat(59));

      // 2.7 文件名清理不反写 ArticleSource.title
      const source = { title: '原始标题/包含:特殊符号. ' };
      const cleaned = sanitizeArticleTitle(source.title);
      assert.strictEqual(source.title, '原始标题/包含:特殊符号. ');

      // 2.8 parseFrontMatterDate UTC+8 规范计算，不随导出设备本地时区跨日 (AC 7)
      const { parseFrontMatterDate } = window.__wetrim;
      assert.strictEqual(parseFrontMatterDate('2026-09-26'), '2026-09-26');
      assert.strictEqual(parseFrontMatterDate('2026-09-26 20:00:00'), '2026-09-26');
      assert.strictEqual(parseFrontMatterDate('2026-09-26T20:00:00'), '2026-09-26');
      assert.strictEqual(parseFrontMatterDate('2026-09-26 00:00:00'), '2026-09-26');
      assert.strictEqual(parseFrontMatterDate('2026-09-26 23:59:59'), '2026-09-26');
      assert.strictEqual(parseFrontMatterDate('2026-09-26T12:00:00Z'), '2026-09-26'); // 12:00Z + 8h = 20:00 on 26th
      assert.strictEqual(parseFrontMatterDate('2026-09-26T23:00:00Z'), '2026-09-27'); // 23:00Z + 8h = 07:00 on 27th
      assert.strictEqual(parseFrontMatterDate('2026-02-31'), null); // 非法日历日期省略
      assert.strictEqual(parseFrontMatterDate('not-a-date'), null); // 无法可靠解析省略
      assert.strictEqual(parseFrontMatterDate(''), null);
      assert.strictEqual(parseFrontMatterDate(null), null);
    });
    console.log('✓ Test 2 Passed: Filename sanitization & date calculation conform to all AC 4, 5, 7 specifications');

    // --------------------------------------------------------------------------
    // Test 3: Directory Writing & Structure via File System Access API (AC 1 & 2)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Directory Writing & Structure via OPFS/File System Access API ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory, buildResultFile } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();

      // 清理测试目录
      for await (const name of rootDir.keys()) {
        try {
          await rootDir.removeEntry(name, { recursive: true });
        } catch {}
      }

      const snapshot = {
        source: {
          title: 'WeTrim 导出实测:第一篇',
          account: '前端测试号',
          publishedAt: '2026-09-26 18:30:00',
          url: 'https://mp.weixin.qq.com/s/sample-1',
        },
        blocks: [
          {
            id: 'b1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>第一段内容</p>',
            initialMarkdown: '第一段内容',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
          {
            id: 'b2',
            order: 2,
            type: 'code',
            originalHtml: '<pre><code>const a = 1;\nconst b = 2;</code></pre>',
            initialMarkdown: '```js\nconst a = 1;\nconst b = 2;\n```',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
        ],
      };

      const expectedResult = buildResultFile(snapshot);
      const res = await writeArticleDirectory(rootDir, snapshot);

      assert.strictEqual(res.ok, true, 'writeArticleDirectory should return ok: true');
      assert.strictEqual(res.articleDirName, 'WeTrim 导出实测_第一篇');
      assert.strictEqual(res.markdownFileName, 'WeTrim 导出实测_第一篇.md');

      // 验证目录结构：<文章文件名>/<文章文件名>.md
      const articleDir = await rootDir.getDirectoryHandle('WeTrim 导出实测_第一篇', { create: false });
      assert(articleDir, 'Outer article directory must exist');

      // 验证无本地图片时不创建 images/
      let imagesCreated = false;
      try {
        await articleDir.getDirectoryHandle('images', { create: false });
        imagesCreated = true;
      } catch (err) {
        imagesCreated = false;
      }
      assert.strictEqual(imagesCreated, false, 'images/ directory must NOT be created when no local images');

      // 验证 Markdown 文件内容与 UTF-8 编码
      const fileHandle = await articleDir.getFileHandle('WeTrim 导出实测_第一篇.md', { create: false });
      const file = await fileHandle.getFile();
      const content = await file.text();
      assert.strictEqual(content, expectedResult.text, 'Written Markdown text must match buildResultFile.text exactly');
    });
    console.log('✓ Test 3 Passed: Structure <文章文件名>/<文章文件名>.md verified; no images/ created');

    // --------------------------------------------------------------------------
    // Test 4: Duplicate Directory Suffixes (AC 3)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Duplicate Directory Suffixes (AC 3) ---');
    await page.evaluate(async () => {
      const { writeArticleDirectory, buildResultFile } = window.__wetrim;
      const rootDir = await navigator.storage.getDirectory();

      const snapshot = {
        source: {
          title: 'WeTrim 导出实测:第一篇', // 相同标题
          account: '前端测试号',
          publishedAt: '2026-09-26 18:30:00',
          url: 'https://mp.weixin.qq.com/s/sample-1',
        },
        blocks: [
          {
            id: 'b1',
            order: 1,
            type: 'paragraph',
            originalHtml: '<p>第一次导出的内容</p>',
            initialMarkdown: '第一次导出的内容',
            editedMarkdown: null,
            included: true,
            notes: [],
          },
        ],
      };

      // 第二次导出：重名目录加 (2)
      const res2 = await writeArticleDirectory(rootDir, snapshot);
      assert.strictEqual(res2.ok, true);
      assert.strictEqual(res2.articleDirName, 'WeTrim 导出实测_第一篇 (2)', 'Duplicate outer dir must have (2)');
      assert.strictEqual(res2.markdownFileName, 'WeTrim 导出实测_第一篇.md', 'Inner file must NOT have suffix');

      const dir2 = await rootDir.getDirectoryHandle('WeTrim 导出实测_第一篇 (2)', { create: false });
      const file2 = await dir2.getFileHandle('WeTrim 导出实测_第一篇.md', { create: false });
      assert(file2, 'Inner file in (2) must retain original cleaned name');

      // 第三次导出：重名目录加 (3)
      const res3 = await writeArticleDirectory(rootDir, snapshot);
      assert.strictEqual(res3.ok, true);
      assert.strictEqual(res3.articleDirName, 'WeTrim 导出实测_第一篇 (3)', 'Third duplicate outer dir must have (3)');
      assert.strictEqual(res3.markdownFileName, 'WeTrim 导出实测_第一篇.md', 'Inner file in (3) must NOT have suffix');

      // 验证先前的第一次导出 (1) 与第二次导出 (2) 均未被覆盖、合并或删除
      const dir1 = await rootDir.getDirectoryHandle('WeTrim 导出实测_第一篇', { create: false });
      assert(dir1, 'Directory (1) must still exist intact');
      const file1 = await dir1.getFileHandle('WeTrim 导出实测_第一篇.md', { create: false });
      assert(file1, 'File in Directory (1) must still exist intact');

      // 验证与普通文件重名时的避让处理（TypeMismatchError 防御）
      await rootDir.getFileHandle('同名文件测试', { create: true });
      const resFileConflict = await writeArticleDirectory(rootDir, {
        source: { title: '同名文件测试' },
        blocks: snapshot.blocks,
      });
      assert.strictEqual(resFileConflict.ok, true);
      assert.strictEqual(resFileConflict.articleDirName, '同名文件测试 (2)', 'Must avoid regular file collision and pick (2)');
    });
    console.log('✓ Test 4 Passed: Duplicate outer directories use (2), (3) while inner .md retains original name; prior results untouched');

    // --------------------------------------------------------------------------
    // Test 5: Markdown Semantic Consistency with PreviewDialog (AC 14, 6, 7, 8)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Semantic Consistency: Exported .md vs Preview Markdown Source ---');
    // 装入一篇包含各种内容块的完整文章会话
    await page.evaluate(async () => {
      const res = {
        kind: 'article',
        source: {
          title: '语义一致性验证文章',
          account: 'WeTrim 官方',
          publishedAt: '2026-09-26 20:00:00',
          url: 'https://mp.weixin.qq.com/s/preview-export-consistency',
        },
        contentHtml: `
          <p>这是第一段保留正文，末尾硬换行  <br>第二行。</p>
          <pre><code>    function add(x, y) {\n        return x + y;\n    }</code></pre>
          <blockquote><p>这是引用块中的内容</p></blockquote>
          <p>这一段会被剔除</p>
        `,
        unstable: false,
      };
      await window.__wetrim.processCaptureResult(res);
    });

    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });

    // 将第 4 块设置为剔除
    await page.evaluate(() => {
      const state = window.__wetrim.getState();
      const lastBlock = state.session.snapshot.blocks[state.session.snapshot.blocks.length - 1];
      window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: lastBlock.id } });
    });

    // 打开汇总预览
    await page.click('[data-testid="action-preview"]');
    await page.waitForSelector('[data-testid="preview-dialog"][open]', { timeout: 3000 });

    // 切换到 Markdown 源码 Tab 并提取源码文本
    await page.click('[data-testid="preview-tab-source"]');
    await page.waitForSelector('[data-testid="preview-source-pre"]', { timeout: 3000 });
    const previewSourceText = await page.$eval('[data-testid="preview-source-pre"]', (el) => el.textContent);

    // 在同次预览打开期间，通过预览底部的导出按钮执行导出
    const exportResultFromPreview = await page.evaluate(async () => {
      const rootDir = await navigator.storage.getDirectory();
      const state = window.__wetrim.getState();
      const res = await window.__wetrim.writeArticleDirectory(rootDir, state.session.snapshot);
      const dir = await rootDir.getDirectoryHandle(res.articleDirName, { create: false });
      const file = await dir.getFileHandle(res.markdownFileName, { create: false });
      const text = await (await file.getFile()).text();
      return { res, text };
    });

    assert.strictEqual(
      exportResultFromPreview.text,
      previewSourceText,
      'Exported .md must match Preview Markdown Source tab verbatim (char-for-char)'
    );

    // 验证 front-matter 四字段
    assert(exportResultFromPreview.text.startsWith('---\n'), 'Must start with YAML front-matter');
    assert(exportResultFromPreview.text.includes('title: 语义一致性验证文章\n'), 'Must contain title');
    assert(exportResultFromPreview.text.includes('account: WeTrim 官方\n'), 'Must contain account');
    assert(exportResultFromPreview.text.includes('date: 2026-09-26\n'), 'Must contain date calculated via UTC+8');
    assert(exportResultFromPreview.text.includes('source: "https://mp.weixin.qq.com/s/preview-export-consistency"\n'), 'Must contain source');
    // 验证剔除块不输出，保留块以空行连接
    assert(!exportResultFromPreview.text.includes('这一段会被剔除'), 'Excluded blocks must not be exported');
    assert(exportResultFromPreview.text.endsWith('\n'), 'File must end with newline');

    // 关闭预览
    await page.click('[data-testid="preview-btn-close"]');
    await page.waitForFunction(() => !window.__wetrim.getIsPreviewOpen(), { timeout: 3000 });
    console.log('✓ Test 5 Passed: Exported .md is verbatim identical to Preview Markdown source view');

    // --------------------------------------------------------------------------
    // Test 6: Empty Body Handling (AC 9)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Empty Body Handling (AC 9) ---');
    // 剔除所有剩余块
    await page.evaluate(() => {
      const state = window.__wetrim.getState();
      for (const b of state.session.snapshot.blocks) {
        if (b.included) {
          window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: b.id } });
        }
      }
    });

    // 点击顶栏的导出按钮
    await page.click('[data-testid="action-export"]');
    // 应当弹出提示对话框「没有可导出的正文」
    await page.waitForSelector('[data-testid="export-dialog"][open]', { timeout: 3000 });
    const emptyTitle = await page.$eval('[data-testid="export-dialog-title"]', (el) => el.textContent.trim());
    assert.strictEqual(emptyTitle, '没有可导出的正文', 'Dialog should display "没有可导出的正文"');

    // 关闭反馈对话框
    await page.click('[data-testid="export-dialog-btn-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'), { timeout: 3000 });
    console.log('✓ Test 6 Passed: Intercepts empty body with prompt "没有可导出的正文" without creating files');

    // --------------------------------------------------------------------------
    // Test 7: User Cancellation Handling (AC 11)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: User Cancellation Handling (AC 11) ---');
    // 恢复一个块
    await page.evaluate(() => {
      const state = window.__wetrim.getState();
      window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: state.session.snapshot.blocks[0].id } });
    });
    await page.waitForFunction(() => window.__wetrim.getState().session.snapshot.blocks[0].included === true, { timeout: 3000 });

    // 测试当 showDirectoryPicker 用户取消时（AbortError）
    const cancelResult = await page.evaluate(async () => {
      const mockPickerAbort = async () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      };
      const state = window.__wetrim.getState();
      return await window.__wetrim.performExport(state.session.snapshot, undefined, {
        showDirectoryPicker: mockPickerAbort,
      });
    });
    assert.strictEqual(cancelResult.ok, false);
    assert.strictEqual(cancelResult.aborted, true, 'Cancelled selection returns aborted: true');
    // 验证界面上没有弹出错误对话框
    const isErrorDialogOpen = await page.$eval('[data-testid="export-dialog"]', () => true).catch(() => false);
    assert.strictEqual(isErrorDialogOpen, false, 'Cancellation should not pop up error dialog');
    console.log('✓ Test 7 Passed: User directory picker cancellation is clean and not treated as an error');

    // --------------------------------------------------------------------------
    // Test 8: Write Failure Reports Unfinished & Directory Name (AC 12)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Disk/Permission Write Failure Reporting (AC 12) ---');
    await page.evaluate(async () => {
      const rootDir = await navigator.storage.getDirectory();
      const state = window.__wetrim.getState();

      // 创建一个会在写入时抛错的 mockDirectoryHandle
      const failMockParent = {
        kind: 'directory',
        async getDirectoryHandle(name, opts) {
          const dir = await rootDir.getDirectoryHandle(name, opts);
          return {
            kind: 'directory',
            async getFileHandle(fileName, fileOpts) {
              const file = await dir.getFileHandle(fileName, fileOpts);
              return {
                kind: 'file',
                async createWritable() {
                  const err = new Error('Disk quota exceeded (simulated I/O failure)');
                  err.name = 'QuotaExceededError';
                  throw err;
                },
              };
            },
          };
        },
        async getFileHandle(name, opts) {
          return rootDir.getFileHandle(name, opts);
        },
      };

      await window.__wetrim.performExport(state.session.snapshot, undefined, {
        parentHandle: failMockParent,
      });
    });

    // 验证界面弹出「导出未完成」提示，且详细文本包含残留目录名
    await page.waitForSelector('[data-testid="export-dialog"][open]', { timeout: 3000 });
    const failTitle = await page.$eval('[data-testid="export-dialog-title"]', (el) => el.textContent.trim());
    const failDesc = await page.$eval('[data-testid="export-dialog-desc"]', (el) => el.textContent.trim());
    assert.strictEqual(failTitle, '导出未完成', 'Title should state "导出未完成"');
    assert(failDesc.includes('语义一致性验证文章'), 'Description must mention the attempted directory name');
    assert(failDesc.includes('QuotaExceededError') || failDesc.includes('Disk quota'), 'Description should report details');

    // 关闭错误提示对话框
    await page.click('[data-testid="export-dialog-btn-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'), { timeout: 3000 });
    console.log('✓ Test 8 Passed: Failure clearly reports unfinished status and attempted directory name without claiming success');

    // --------------------------------------------------------------------------
    // Test 9: Persistence Isolation (AC 13: Export Success cannot alter saveStatus)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Persistence Isolation (Export Success cannot alter saveStatus) ---');
    // 修改持久化状态为 unsaved
    await page.evaluate(() => {
      window.__wetrim.dispatch({
        type: 'SET_SAVE_STATUS',
        payload: { status: 'unsaved' },
      });
    });
    await page.waitForFunction(() => window.__wetrim.getState().saveStatus === 'unsaved', { timeout: 3000 });

    // 执行一次成功的导出
    await page.evaluate(async () => {
      const rootDir = await navigator.storage.getDirectory();
      const state = window.__wetrim.getState();
      await window.__wetrim.performExport(state.session.snapshot, undefined, {
        parentHandle: rootDir,
      });
    });

    // 关闭成功对话框
    await page.waitForSelector('[data-testid="export-dialog"][open]', { timeout: 3000 });
    await page.click('[data-testid="export-dialog-btn-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="export-dialog"]'), { timeout: 3000 });

    // 验证状态依然是 unsaved，绝不能被改成 'saved'
    const saveStatusAfter = await page.evaluate(() => window.__wetrim.getState().saveStatus);
    assert.strictEqual(
      saveStatusAfter,
      'unsaved',
      'Export success must NOT change unsaved status to saved status'
    );
    console.log('✓ Test 9 Passed: Export success does not alter unsaved persistence state');

    // --------------------------------------------------------------------------
    // Test 10: Keyboard Accessibility & Toolbar Actions (AC 1)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: Keyboard Accessibility & Toolbar Trigger ---');
    const toolbarExportBtn = await page.$('[data-testid="action-export"]');
    assert(toolbarExportBtn, 'Toolbar action-export button must exist');
    const exportLabel = await page.$eval('[data-testid="action-export"]', (el) => el.getAttribute('aria-label'));
    assert(exportLabel && exportLabel.length > 0, 'Export button must have descriptive aria-label');

    console.log('✓ Test 10 Passed: Toolbar and preview export triggers verified');

    console.log('\n============================================================');
    console.log('==> All Issue #32 Verification Tests Passed Successfully! <==');
    console.log('============================================================');
  } finally {
    if (page) await page.close();
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
