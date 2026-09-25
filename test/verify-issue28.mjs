import puppeteer from 'puppeteer';
import path from 'path';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

/**
 * 在 service worker 中替换 chrome.scripting.executeScript：计数，并以延迟返回给定抓取结果，
 * 用于经由真实点击入口验证「不重抓 / 不并发抓两次」。
 */
async function stubExecuteScript(worker, result = { kind: 'noArticle' }) {
  await worker.evaluate((res) => {
    self.__execCount = 0;
    self.__origExecuteScript = self.__origExecuteScript || chrome.scripting.executeScript;
    chrome.scripting.executeScript = async () => {
      self.__execCount += 1;
      await new Promise((r) => setTimeout(r, 300));
      return [{ result: res }];
    };
  }, result);
}

async function restoreExecuteScript(worker) {
  await worker.evaluate(() => {
    chrome.scripting.executeScript = self.__origExecuteScript;
  });
}

async function run() {
  console.log('==> Starting Issue #28 Verification (Candidate Snapshot, Re-entrancy Guard, & Replacement Confirmation Modal)...');

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

    // Ensure clean storage
    await worker.evaluate(() => chrome.storage.local.clear());

    page = await browser.newPage();
    page.on('console', (msg) => console.log('[Browser Console]', msg.text()));
    page.on('pageerror', (err) => console.log('[Browser Page Error]', err));
    await page.setViewport({ width: 1200, height: 800 });
    const appUrl = `chrome-extension://${extId}/app.html`;
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // --------------------------------------------------------------------------
    // Test 2: Initial capture when no old session:
    //         先落盘，再启用；无旧会话时不弹确认，直接进入清洗
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Initial capture when no old session (enters cleaning directly without confirmation) ---');
    const article1 = {
      kind: 'article',
      source: {
        title: '第一篇文章：技术架构规范',
        account: '印厂技术谈',
        publishedAt: '2026-09-01',
        url: 'https://mp.weixin.qq.com/s/article-1',
      },
      contentHtml: '<p>正文第 1 块：前言内容</p><p>正文第 2 块：架构设计思想</p><p>正文第 3 块：持久化与候选</p>',
      unstable: false,
    };

    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, article1);

    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    // Verify dialog is NOT displayed
    const hasDialogTest2 = await page.$eval('.candidate-confirm-dialog', (el) => el.hasAttribute('open')).catch(() => false);
    assert.strictEqual(hasDialogTest2, false, 'No confirmation dialog should appear when there is no prior session');

    // Storage verification: candidateSnapshot must be removed, currentSession must exist
    const storageDumpTest2 = await worker.evaluate(() => chrome.storage.local.get(null));
    assert(storageDumpTest2.currentSession, 'currentSession must exist in storage');
    assert.strictEqual(storageDumpTest2.candidateSnapshot, undefined, 'candidateSnapshot must be removed after being promoted');
    console.log('✓ Test 2 Passed: Initial capture promoted directly to session without modal');

    // --------------------------------------------------------------------------
    // Test 3: Second capture while cleaning:
    //         先落盘写入 candidateSnapshot，成功后弹换稿通知单，旧会话在背后渲染并压暗
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Subsequent capture enters candidateConfirm modal over cleaning page ---');
    
    // First, modify session: exclude block 1, edit block 2
    await page.evaluate(async () => {
      const { dispatch, loadSession } = window.__wetrim;
      const cur = await loadSession();
      if (cur && cur.snapshot.blocks.length >= 2) {
        dispatch({
          type: 'TOGGLE_BLOCK',
          payload: { blockId: cur.snapshot.blocks[0].id },
        });
        dispatch({
          type: 'UPDATE_BLOCK',
          payload: { blockId: cur.snapshot.blocks[1].id, editedMarkdown: '【已手工编辑】' },
        });
      }
    });
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    const article2 = {
      kind: 'article',
      source: {
        title: '第二篇文章：生产排版指南',
        account: '印厂技术谈',
        publishedAt: '2026-09-02',
        url: 'https://mp.weixin.qq.com/s/article-2',
      },
      contentHtml: '<p>新稿正文第 1 块</p><p>新稿正文第 2 块</p>',
      unstable: true, // test unstable warning
    };

    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, article2);

    // Wait for candidate confirm modal
    await page.waitForSelector('[data-testid="candidate-confirm-card"]', { timeout: 5000 });
    const viewModeAfterCapture = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(viewModeAfterCapture, 'candidateConfirm', 'viewMode must transition to candidateConfirm');

    // 1. Verify candidateSnapshot is saved on disk in storage
    const storageDumpTest3 = await worker.evaluate(() => chrome.storage.local.get('candidateSnapshot'));
    assert(storageDumpTest3.candidateSnapshot, 'candidateSnapshot must exist in chrome.storage.local');
    assert.strictEqual(
      storageDumpTest3.candidateSnapshot.snapshot.source.title,
      '第二篇文章：生产排版指南',
      'candidateSnapshot on disk must contain the new article'
    );

    // 2. Verify underlying cleaning session is STILL rendered behind the modal (§8.5)
    const hasManuscriptSlip = await page.$eval('[data-testid="manuscript-slip"]', (el) => Boolean(el));
    assert.strictEqual(hasManuscriptSlip, true, 'Old cleaning session must remain rendered in background');

    // 3. Verify modal elements: stamp, header, new section, old section, unstable warning
    const stampText = await page.$eval('.candidate-stamp', (el) => el.textContent.trim());
    assert.strictEqual(stampText, '待确认', 'Stamp must say "待确认"');

    const subTitle = await page.$eval('.notice-sub', (el) => el.textContent.trim());
    assert.strictEqual(subTitle, '换稿通知单', 'Kicker must say "换稿通知单"');

    const newSectionTitle = await page.$eval('[data-testid="candidate-new-section"] .candidate-article-title', (el) => el.textContent.trim());
    assert(newSectionTitle.includes('第二篇文章：生产排版指南'), 'New section must display new article title');

    const hasUnstableWarning = await page.$eval('[data-testid="candidate-unstable-note"]', (el) => Boolean(el));
    assert.strictEqual(hasUnstableWarning, true, 'Unstable capture warning must be present in new section');

    const oldSectionTitle = await page.$eval('[data-testid="candidate-old-section"] .candidate-article-title', (el) => el.textContent.trim());
    assert(oldSectionTitle.includes('第一篇文章：技术架构规范'), 'Old section must display old article title');

    // 4. Verify loss notice reflects 1 excluded block and 1 edited block
    const lossText = await page.$eval('[data-testid="candidate-loss-notice"]', (el) => el.textContent.trim());
    console.log('Loss notice text:', lossText);
    assert(lossText.includes('剔除的 1 块') && lossText.includes('编辑的 1 块'), 'Loss notice must state 1 excluded and 1 edited block');

    // 5. Verify default focus is on "继续当前清洗" button
    const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeTestId, 'candidate-btn-continue', 'Focus must be on "继续当前清洗" button');
    // 6. 签条过高时内部可滚动，按钮不会落到可视区外
    const dialogOverflowY = await page.$eval('.candidate-confirm-dialog', (el) => getComputedStyle(el).overflowY);
    assert.strictEqual(dialogOverflowY, 'auto', 'Dialog must scroll internally when taller than viewport');

    // 7. 未打开的签条不得显示（作者样式不能覆盖 dialog:not([open]) 的隐藏）
    const closedDialogDisplay = await page.evaluate(() => {
      const probe = document.createElement('dialog');
      probe.className = 'candidate-confirm-dialog';
      document.body.appendChild(probe);
      const display = getComputedStyle(probe).display;
      probe.remove();
      return display;
    });
    assert.strictEqual(closedDialogDisplay, 'none', 'Closed candidate dialog must not be displayed');
    console.log('✓ Test 3 Passed: Candidate confirmation modal renders correctly over background session with proper details');

    // --------------------------------------------------------------------------
    // Test 4: Overwrite candidate with 3rd article:
    //         已有候选但是另一篇 -> 原地换成新的那篇，焦点重置到「继续」
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Subsequent 3rd article overwrites candidate in place ---');
    const article3 = {
      kind: 'article',
      source: {
        title: '第三篇文章：最终定稿版',
        account: '印厂技术谈',
        publishedAt: '2026-09-03',
        url: 'https://mp.weixin.qq.com/s/article-3',
      },
      contentHtml: '<p>第三篇正文内容</p>',
      unstable: false,
    };

    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, article3);

    // Verify modal updated in place
    const updatedNewTitle = await page.$eval('[data-testid="candidate-new-section"] .candidate-article-title', (el) => el.textContent.trim());
    assert(updatedNewTitle.includes('第三篇文章：最终定稿版'), 'Modal must update in place with third article title');

    const storageDumpTest4 = await worker.evaluate(() => chrome.storage.local.get('candidateSnapshot'));
    assert.strictEqual(
      storageDumpTest4.candidateSnapshot.snapshot.source.title,
      '第三篇文章：最终定稿版',
      'Storage candidateSnapshot must be overwritten with article 3'
    );

    const activeAfterOverwrite = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert.strictEqual(activeAfterOverwrite, 'candidate-btn-continue', 'Focus must reset to "继续当前清洗" button on overwrite');
    console.log('✓ Test 4 Passed: Overwrite candidate in place with focus reset to continue');

    // --------------------------------------------------------------------------
    // Test 5: Background re-entrancy & same-URL protection（经由 service worker 的真实点击入口）:
    //         已有候选且是同一 URL（全页仍开着）-> 不重新抓取
    //         抓取进行中再点 -> 忽略，不并发抓两次
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Same URL candidate protection & re-entrancy guard in background ---');
    await stubExecuteScript(worker);

    // 5a. 同一 URL 且全页开着：不注入抓取，确认框仍是第三篇
    await worker.evaluate(() =>
      self.__wetrimBackground.handleActionClick({ id: 999999, url: 'https://mp.weixin.qq.com/s/article-3' })
    );
    const execCountSameUrl = await worker.evaluate(() => self.__execCount);
    assert.strictEqual(execCountSameUrl, 0, 'Same-URL click with open app page must not re-capture');
    const dialogStillArticle3 = await page.$eval('[data-testid="candidate-new-section"] .candidate-article-title', (el) => el.textContent.trim());
    assert(dialogStillArticle3.includes('第三篇文章：最终定稿版'), 'Existing confirm dialog must stay in place');

    // 5b. 两次快速点击另一篇：只抓取一次
    await worker.evaluate(() => {
      const tab = { id: 999999, url: 'https://mp.weixin.qq.com/s/another-article' };
      return Promise.all([
        self.__wetrimBackground.handleActionClick(tab),
        self.__wetrimBackground.handleActionClick(tab),
      ]);
    });
    const execCountDoubleClick = await worker.evaluate(() => self.__execCount);
    assert.strictEqual(execCountDoubleClick, 1, 'Two rapid clicks must trigger exactly one capture');
    await restoreExecuteScript(worker);

    // 抓取结果（noArticle）被全页消费，确认框不受影响
    await page.waitForFunction(async () => !(await chrome.storage.local.get('pendingCapture')).pendingCapture, { timeout: 5000 });
    const dialogOpenAfterGuard = await page.$eval('.candidate-confirm-dialog', (el) => el.hasAttribute('open'));
    assert.strictEqual(dialogOpenAfterGuard, true, 'Confirm dialog must remain open');
    console.log('✓ Test 5 Passed: Same-URL click keeps dialog without re-capture; rapid clicks capture once');

    // --------------------------------------------------------------------------
    // Test 6: Continue cleaning flow (Esc or click "继续当前清洗"):
    //         删除候选、关闭签条，旧内容一字未变，阅读位置与焦点恢复
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Choose "继续当前清洗" flow ---');
    await page.click('[data-testid="candidate-btn-continue"]');

    // Modal should close
    await page.waitForFunction(() => !document.querySelector('.candidate-confirm-dialog') || !document.querySelector('.candidate-confirm-dialog').hasAttribute('open'));

    const viewModeAfterContinue = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(viewModeAfterContinue, 'cleaning', 'viewMode must return to cleaning');

    // Storage candidate must be deleted
    const storageAfterContinue = await worker.evaluate(() => chrome.storage.local.get('candidateSnapshot'));
    assert.strictEqual(storageAfterContinue.candidateSnapshot, undefined, 'candidateSnapshot must be deleted from storage');

    // Old session content unchanged
    const oldTitleInView = await page.$eval('.slip-title', (el) => el.textContent.trim());
    assert.strictEqual(oldTitleInView, '第一篇文章：技术架构规范', 'Old session title must remain intact');
    console.log('✓ Test 6 Passed: Continue cleaning dismisses modal, deletes candidate, keeps old session');

    // --------------------------------------------------------------------------
    // Test 7: Loss warning text formatting for all variations
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Loss notice text variations (unmodified, same URL) ---');
    // Test same URL capture
    const sameUrlArticle = {
      kind: 'article',
      source: {
        title: '第一篇文章：技术架构规范（重新抓取）',
        account: '印厂技术谈',
        publishedAt: '2026-09-01',
        url: 'https://mp.weixin.qq.com/s/article-1', // Same URL!
      },
      contentHtml: '<p>正文第 1 块：新抓取</p>',
      unstable: false,
    };
    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, sameUrlArticle);

    await page.waitForSelector('[data-testid="candidate-confirm-card"]', { timeout: 5000 });
    const sameUrlLossText = await page.$eval('[data-testid="candidate-loss-notice"]', (el) => el.textContent.trim());
    console.log('Same URL loss text:', sameUrlLossText);
    assert.strictEqual(
      sameUrlLossText,
      '这是同一篇文章的新抓取。替换后按新内容重新开始，之前的剔除和编辑不会带过来。',
      'Same URL must use ADR-0002 dedicated loss notice'
    );

    // Close dialog
    await page.click('[data-testid="candidate-btn-continue"]');
    await page.waitForFunction(() => !document.querySelector('.candidate-confirm-dialog') || !document.querySelector('.candidate-confirm-dialog').hasAttribute('open'));

    console.log('✓ Test 7 Passed: Loss warning accurately adapts to same URL and edit states');

    // --------------------------------------------------------------------------
    // Test 8: Replace flow:
    //         写入新会话，成功后删除候选，滚动到顶部，焦点放到标题
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Replace session flow ---');
    const replaceArticle = {
      kind: 'article',
      source: {
        title: '第四篇最终替换文稿',
        account: '新公众号',
        publishedAt: '2026-09-04',
        url: 'https://mp.weixin.qq.com/s/article-4',
      },
      contentHtml: '<p>替换正文第 1 块</p><p>替换正文第 2 块</p>',
      unstable: false,
    };
    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, replaceArticle);
    await page.waitForSelector('[data-testid="candidate-confirm-card"]', { timeout: 5000 });

    // 放慢 currentSession 写入并计数，以便观察替换进行中的状态
    await page.evaluate(() => {
      const origSet = chrome.storage.local.set;
      window._origStorageSetSlow = origSet;
      window._writtenSessionIds = new Set();
      chrome.storage.local.set = async (items) => {
        if (items && 'currentSession' in items) {
          window._writtenSessionIds.add(items.currentSession.sessionId);
          await new Promise((r) => setTimeout(r, 300));
        }
        return origSet.call(chrome.storage.local, items);
      };
    });

    // 连点两次替换：只能生成一个新会话
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="candidate-btn-replace"]');
      btn.click();
      btn.click();
    });

    // 替换进行中：两个按钮禁用，Esc 不会触发「继续」
    await page.waitForSelector('[data-testid="candidate-btn-continue"]:disabled', { timeout: 2000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.candidate-confirm-dialog') || !document.querySelector('.candidate-confirm-dialog').hasAttribute('open'));

    // 替换成功后会话变更 effect 会把同一新会话再入队一次，因此按 sessionId 去重计数
    const writtenSessionCount = await page.evaluate(() => {
      chrome.storage.local.set = window._origStorageSetSlow;
      return window._writtenSessionIds.size;
    });
    assert.strictEqual(writtenSessionCount, 1, 'Double-clicking replace must create exactly one new session');

    // Check title updated to new article
    await page.waitForSelector('.slip-title', { timeout: 5000 });
    const replacedTitle = await page.$eval('.slip-title', (el) => el.textContent.trim());
    assert.strictEqual(replacedTitle, '第四篇最终替换文稿', 'Session title must be updated to new article');

    // Check focus on title
    await page.waitForFunction(
      () => document.activeElement?.classList.contains('slip-title'),
      { timeout: 5000 }
    );

    // Check candidateSnapshot removed from storage
    const storageAfterReplace = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.strictEqual(storageAfterReplace.candidateSnapshot, undefined, 'candidateSnapshot must be removed after replace');
    assert.strictEqual(storageAfterReplace.currentSession.snapshot.source.title, '第四篇最终替换文稿', 'currentSession must be new article');
    console.log('✓ Test 8 Passed: Replace session successfully updates state, clears candidate, focuses title');

    // --------------------------------------------------------------------------
    // Test 9: Replace write failure handling:
    //         替换写入失败 -> 签条保留，旧会话不动，签条内加错误提示，可重试
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Replace write failure handling ---');
    const articleForFail = {
      kind: 'article',
      source: {
        title: '第五篇失败模拟文稿',
        account: '测试',
        publishedAt: '2026-09-05',
        url: 'https://mp.weixin.qq.com/s/article-5',
      },
      contentHtml: '<p>正文内容</p>',
      unstable: false,
    };
    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, articleForFail);
    await page.waitForSelector('[data-testid="candidate-confirm-card"]', { timeout: 5000 });

    // Inject simulated failure into chrome.storage.local.set for currentSession
    await page.evaluate(() => {
      const origSet = chrome.storage.local.set;
      window._origStorageSet = origSet;
      chrome.storage.local.set = async (items) => {
        if (items && 'currentSession' in items) {
          throw new Error('QUOTA_BYTES_EXCEEDED: Simulated disk failure');
        }
        return origSet.call(chrome.storage.local, items);
      };
    });

    // 旧会话先进入保存失败状态（存储持续拒绝写入）
    await page.evaluate(async () => {
      const cur = await window.__wetrim.loadSession();
      window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: cur.snapshot.blocks[0].id } });
    });
    await page.waitForSelector('[data-save-status="error"]', { timeout: 5000 });

    await page.click('[data-testid="candidate-btn-replace"]');

    // 替换不能因为旧会话保存失败而卡住，也不能无限重写
    await page.waitForSelector('[data-testid="candidate-replace-error"]', { timeout: 5000 });
    const writeAttempts = await page.evaluate(async () => {
      let count = 0;
      const failingSet = chrome.storage.local.set;
      chrome.storage.local.set = async (items) => {
        if (items && 'currentSession' in items) count += 1;
        return failingSet.call(chrome.storage.local, items);
      };
      await new Promise((r) => setTimeout(r, 500));
      chrome.storage.local.set = failingSet;
      return count;
    });
    assert.strictEqual(writeAttempts, 0, 'Failed old-session save must not be retried in an endless loop');

    // Dialog must remain open!
    const dialogOpenAfterFail = await page.$eval('.candidate-confirm-dialog', (el) => el.hasAttribute('open'));
    assert.strictEqual(dialogOpenAfterFail, true, 'Dialog must remain open when replace write fails');

    // Error message must appear
    await page.waitForSelector('[data-testid="candidate-replace-error"]', { timeout: 5000 });
    const replaceErrorText = await page.$eval('[data-testid="candidate-replace-error"]', (el) => el.textContent.trim());
    assert(replaceErrorText.includes('替换没有完成，当前清洗没有被动过'), 'Error message must match spec');

    // Restore chrome.storage.local.set and dismiss
    await page.evaluate(() => {
      if (window._origStorageSet) {
        chrome.storage.local.set = window._origStorageSet;
      }
    });
    await page.click('[data-testid="candidate-btn-continue"]');
    await page.waitForFunction(() => !document.querySelector('.candidate-confirm-dialog') || !document.querySelector('.candidate-confirm-dialog').hasAttribute('open'));

    // 旧会话仍可手动重试保存
    await page.click('[data-save-status="error"]');
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
    console.log('✓ Test 9 Passed: Replace write failure gracefully leaves old session untouched and displays error');

    // --------------------------------------------------------------------------
    // Test 10: Candidate write failure handling:
    //          候选写盘失败 -> 不弹确认，页边夹签提示且不自动收回
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: Candidate disk write failure handling ---');
    // Simulate failure on candidateSnapshot write in chrome.storage.local
    await page.evaluate(() => {
      const origSet = chrome.storage.local.set;
      chrome.storage.local.set = async (items) => {
        if (items && 'candidateSnapshot' in items) {
          throw new Error('Disk full');
        }
        return origSet.call(chrome.storage.local, items);
      };
      window._restoreChromeStorage = () => {
        chrome.storage.local.set = origSet;
      };
    });

    const articleCandidateFail = {
      kind: 'article',
      source: {
        title: '候选写盘失败测试文章',
        account: '测试',
        publishedAt: '2026-09-06',
        url: 'https://mp.weixin.qq.com/s/article-cand-fail',
      },
      contentHtml: '<p>正文</p>',
      unstable: false,
    };

    await page.evaluate(async (res) => {
      await window.__wetrim.processCaptureResult(res);
    }, articleCandidateFail);

    // Verify dialog did NOT appear
    const hasModalOnCandFail = await page.$eval('.candidate-confirm-dialog', (el) => el.hasAttribute('open')).catch(() => false);
    assert.strictEqual(hasModalOnCandFail, false, 'No confirmation dialog should appear when candidate save fails');

    // Verify margin clip note appeared with correct text
    await page.waitForSelector('[data-testid="margin-clip-note"]', { timeout: 5000 });
    const clipNoteText = await page.$eval('.clip-text', (el) => el.textContent.trim());
    assert(clipNoteText.includes('新文章没保存下来，当前清洗没有被动过'), 'Clip note must display persistence failure warning');

    // Wait 4.5 seconds to verify it does NOT auto-dismiss
    await new Promise((r) => setTimeout(r, 4500));
    const stillHasClipNote = await page.$eval('[data-testid="margin-clip-note"]', (el) => Boolean(el)).catch(() => false);
    assert.strictEqual(stillHasClipNote, true, 'Failure clip note must NOT auto-dismiss; user must close manually');

    // Close clip note manually
    await page.click('.clip-close-btn');
    await page.waitForFunction(() => !document.querySelector('[data-testid="margin-clip-note"]'));

    // Restore chrome.storage
    await page.evaluate(() => {
      if (window._restoreChromeStorage) window._restoreChromeStorage();
    });
    console.log('✓ Test 10 Passed: Candidate save failure leaves session untouched and shows non-auto-dismissing clip note');

    // --------------------------------------------------------------------------
    // Test 11: Discard stale candidate on page reload / restart:
    //          候选未处理就关页 -> 丢弃候选，下次打开直接恢复旧会话
    //          候选永远不会自动提升为当前会话
    // --------------------------------------------------------------------------
    console.log('\n--- Test 11: Discard stale candidate on reload / restart ---');
    // Put a stale candidate into storage while page is closed
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        candidateSnapshot: {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            snapshotId: 'stale-cand-1',
            capturedAt: new Date().toISOString(),
            source: {
              title: '未处理的残留候选文章',
              account: '残留号',
              publishedAt: '2026-09-07',
              url: 'https://mp.weixin.qq.com/s/stale-candidate',
            },
            blocks: [],
            images: [],
            captureWarnings: [],
          },
        },
      });
    });

    // Reload page
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });
    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });

    // Verify session restored is the OLD session, NOT candidate!
    const restoredTitle = await page.$eval('.slip-title', (el) => el.textContent.trim());
    assert.strictEqual(restoredTitle, '第四篇最终替换文稿', 'Reload must restore existing session, not promote candidate');

    // Verify candidateSnapshot in storage was discarded
    const storageAfterReload = await worker.evaluate(() => chrome.storage.local.get('candidateSnapshot'));
    assert.strictEqual(storageAfterReload.candidateSnapshot, undefined, 'Stale candidate must be discarded on init');

    // Verify no confirmation dialog on startup
    const hasDialogOnReload = await page.$eval('.candidate-confirm-dialog', (el) => el.hasAttribute('open')).catch(() => false);
    assert.strictEqual(hasDialogOnReload, false, 'No confirmation dialog on page start');
    console.log('✓ Test 11 Passed: Stale candidates discarded on startup without auto-promotion or confirm popup');

    // --------------------------------------------------------------------------
    // Test 12: Read-only second instance（真实的第二个扩展全页标签）:
    //          只读页不消费 pendingCapture、不写 storage、不显示保存状态；
    //          service worker 的叫醒消息只发给写入方
    // --------------------------------------------------------------------------
    console.log('\n--- Test 12: Read-only secondary instance isolation ---');
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1200, height: 800 });
    await page2.goto(appUrl, { waitUntil: 'networkidle0' });
    await page2.waitForSelector('[data-testid="read-only-note"]', { timeout: 5000 });

    const readOnlyUi = await page2.evaluate(() => ({
      hasSaveStatus: Boolean(document.querySelector('[data-testid="save-status"]')),
      slipInert: document.querySelector('[data-testid="manuscript-slip"]')?.hasAttribute('inert'),
      hasSwitchBtn: Boolean(document.querySelector('[data-testid="read-only-switch-writer"]')),
    }));
    assert.strictEqual(readOnlyUi.hasSaveStatus, false, 'Read-only page must not show save status');
    assert.strictEqual(readOnlyUi.slipInert, true, 'Read-only manuscript must be inert');
    assert.strictEqual(readOnlyUi.hasSwitchBtn, true, 'Read-only page must offer switching to the writer page');
    const writerIsEditable = await page.$eval('[data-testid="manuscript-slip"]', (el) => !el.hasAttribute('inert'));
    assert.strictEqual(writerIsEditable, true, 'First app page must stay the writer');

    // 只读页的内存改动不写 storage
    const revisionBefore = (await worker.evaluate(() => chrome.storage.local.get('currentSession'))).currentSession.revision;
    await page2.evaluate(async () => {
      const cur = await window.__wetrim.loadSession();
      window.__wetrim.dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId: cur.snapshot.blocks[0].id } });
    });
    await new Promise((r) => setTimeout(r, 500));
    const revisionAfter = (await worker.evaluate(() => chrome.storage.local.get('currentSession'))).currentSession.revision;
    assert.strictEqual(revisionAfter, revisionBefore, 'Read-only page edits must not be written to storage');

    // 直接叫醒只读页：不得消费 pendingCapture
    const page2TabId = await page2.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    await worker.evaluate(async (tabId) => {
      await chrome.storage.local.set({ pendingCapture: { capturedAt: new Date().toISOString(), result: { kind: 'noArticle' } } });
      await chrome.tabs.sendMessage(tabId, { type: 'pending-capture' });
    }, page2TabId);
    await new Promise((r) => setTimeout(r, 500));
    const pendingAfterReadOnlyWake = await worker.evaluate(() => chrome.storage.local.get('pendingCapture'));
    assert(pendingAfterReadOnlyWake.pendingCapture, 'Read-only page must not consume pendingCapture');

    // 经由点击入口的真实抓取：叫醒并聚焦写入方，由写入方弹出确认框
    await stubExecuteScript(worker, {
      kind: 'article',
      source: { title: '只读仲裁测试文章', account: '测试', publishedAt: '2026-09-08', url: 'https://mp.weixin.qq.com/s/read-only-routing' },
      contentHtml: '<p>只读仲裁正文</p>',
      unstable: false,
    });
    await worker.evaluate(() =>
      self.__wetrimBackground.handleActionClick({ id: 999999, url: 'https://mp.weixin.qq.com/s/read-only-routing' })
    );
    await restoreExecuteScript(worker);
    await page.waitForSelector('.candidate-confirm-dialog[open]', { timeout: 5000 });
    const readOnlyViewMode = await page2.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(readOnlyViewMode, 'cleaning', 'Read-only page must not enter candidateConfirm');
    await page.click('[data-testid="candidate-btn-continue"]');
    await page.waitForFunction(() => !document.querySelector('.candidate-confirm-dialog[open]'));
    await page2.close();
    console.log('✓ Test 12 Passed: Read-only instance never consumes captures or writes storage; worker wakes the writer');

    // --------------------------------------------------------------------------
    // Test 13: 全页已关闭时残留的同 URL 候选不得吞掉点击
    // --------------------------------------------------------------------------
    console.log('\n--- Test 13: Stale same-URL candidate with app page closed still captures ---');
    await page.close();
    page = null;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        candidateSnapshot: {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            snapshotId: 'stale-same-url',
            capturedAt: new Date().toISOString(),
            source: { title: '残留同 URL 候选', account: '测试', publishedAt: '2026-09-09', url: 'https://mp.weixin.qq.com/s/stale-same-url' },
            blocks: [],
            images: [],
            captureWarnings: [],
          },
        },
      });
    });
    await stubExecuteScript(worker, {
      kind: 'article',
      source: { title: '残留同 URL 重新抓取', account: '测试', publishedAt: '2026-09-09', url: 'https://mp.weixin.qq.com/s/stale-same-url' },
      contentHtml: '<p>重新抓取正文</p>',
      unstable: false,
    });
    const newAppTarget = browser.waitForTarget((t) => t.type() === 'page' && t.url().endsWith('/app.html'), { timeout: 5000 });
    await worker.evaluate(() =>
      self.__wetrimBackground.handleActionClick({ id: 999999, url: 'https://mp.weixin.qq.com/s/stale-same-url' })
    );
    const execCountStale = await worker.evaluate(() => self.__execCount);
    await restoreExecuteScript(worker);
    assert.strictEqual(execCountStale, 1, 'Stale same-URL candidate without an open app page must not block capture');

    page = await (await newAppTarget).page();
    await page.waitForSelector('.candidate-confirm-dialog[open]', { timeout: 5000 });
    const reopenedCandidateTitle = await page.$eval('[data-testid="candidate-new-section"] .candidate-article-title', (el) => el.textContent.trim());
    assert(reopenedCandidateTitle.includes('残留同 URL 重新抓取'), 'Freshly captured article must be offered for confirmation');
    console.log('✓ Test 13 Passed: Click is not swallowed by a stale candidate after the app page was closed');

    console.log('\n=============================================');
    console.log('✓ All Issue #28 acceptance criteria verified successfully!');
    console.log('=============================================');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
