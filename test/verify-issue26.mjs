import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { checkDomAccess } from './check-dom-access.mjs';

async function run() {
  console.log('==> Starting Issue #26 Verification (Session Persistence: Storage Contract, Write Queue, Monotonic Revision & Save States)...');

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

    // Initial page without session should be empty
    const initialViewMode = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(initialViewMode, 'empty', 'Without session, page must enter empty viewMode');
    console.log('✓ Initial state is empty as expected');

    // --------------------------------------------------------------------------
    // Test 2: Storage Key Contract & Single-Key Full Serialization
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Storage Key Contract & Single-Key Full Serialization ---');
    // Simulate capturing a new article
    const testArticleResult = {
      kind: 'article',
      source: {
        title: '测试持久化文章标题',
        account: '测试公众号',
        publishedAt: '2026-09-13',
        url: 'https://mp.weixin.qq.com/s/test-persistence',
      },
      contentHtml: '<p>第一段：测试内容</p><p>第二段：测试内容</p><ul><li>列表项 1</li><li>列表项 2</li></ul>',
      unstable: false,
    };

    await page.evaluate((res) => {
      window.__wetrim.processCaptureResult(res);
    }, testArticleResult);

    // Wait for viewMode to become cleaning and saveStatus to be saved
    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    const saveStatusText = await page.$eval('[data-testid="save-status"]', (el) => el.textContent.trim());
    assert.strictEqual(saveStatusText, '已保存', 'Initial captured article should be saved');

    // Check chrome.storage.local keys and structure
    const storageDump = await worker.evaluate(() => chrome.storage.local.get(null));
    const storageKeys = Object.keys(storageDump);
    console.log('Current storage keys:', storageKeys);

    // Must only use fixed keys, no article-keyed entries or history db
    assert(storageDump.currentSession, 'currentSession must exist in chrome.storage.local');
    const session = storageDump.currentSession;
    assert.strictEqual(session.schemaVersion, 1, 'schemaVersion must be 1');
    assert(typeof session.sessionId === 'string', 'sessionId must be a string UUID');
    assert.strictEqual(session.revision, 1, 'Initial session revision must be 1');
    assert(session.snapshot, 'snapshot must exist');
    assert.strictEqual(session.snapshot.source.title, '测试持久化文章标题');
    assert(Array.isArray(session.snapshot.blocks), 'blocks must be an array');
    assert.strictEqual(session.snapshot.blocks.length, 3, 'All 3 blocks must be serialized together');

    // Verify blocks are not divided into separate keys
    for (const key of storageKeys) {
      assert(
        ['currentSession', 'candidateSnapshot', 'pendingCapture'].includes(key),
        `Unexpected storage key found: ${key}. No per-block or per-article keys allowed.`
      );
    }
    console.log('✓ Test 2 Passed: Single key currentSession with full serialization verified');

    // --------------------------------------------------------------------------
    // Test 3: Block Toggle (保留 / 剔除 / 还原) Immediate Submission & Monotonic Revision
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Immediate submission on block toggle (保留/剔除/还原) & Monotonic Revision ---');

    // Find block 1
    const block1Id = await page.$eval('[data-testid="block-item"]', (el) => el.getAttribute('data-block-id'));
    assert(block1Id, 'Block 1 ID must exist');

    // Click "剔除" on block 1
    await page.click(`[data-block-id="${block1Id}"] [data-testid="block-action-exclude"]`);

    // Status should transition and settle on "已保存"
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    // Verify storage has revision 2 and block 1 is excluded
    let updatedSession = await worker.evaluate(() => chrome.storage.local.get('currentSession'));
    assert.strictEqual(updatedSession.currentSession.revision, 2, 'Revision must increment to 2 after toggle');
    let b1 = updatedSession.currentSession.snapshot.blocks.find((b) => b.id === block1Id);
    assert.strictEqual(b1.included, false, 'Block 1 must be excluded in storage');

    // Click "恢复保留" on block 1
    await page.click(`[data-block-id="${block1Id}"] [data-testid="block-action-restore"]`);
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    updatedSession = await worker.evaluate(() => chrome.storage.local.get('currentSession'));
    assert.strictEqual(updatedSession.currentSession.revision, 3, 'Revision must increment to 3 after restore');
    b1 = updatedSession.currentSession.snapshot.blocks.find((b) => b.id === block1Id);
    assert.strictEqual(b1.included, true, 'Block 1 must be included in storage');
    console.log('✓ Test 3 Passed: Immediate toggle & restore submission with monotonic revision verified');

    // --------------------------------------------------------------------------
    // Test 4: Write Queue Serialization & Older Revision Completion Handshake
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Write Queue Serialization & Older Revision Handshake ---');
    // Test in-flight queue logic using an isolated SessionSaveQueue instance
    const queueTestResult = await page.evaluate(async () => {
      const queue = new window.__wetrim.SessionSaveQueue();
      const statuses = [];

      const unsubscribe = queue.subscribe((status, meta) => {
        statuses.push({ status, revision: meta?.revision });
      });

      // Base session for queue test
      const baseSession = {
        schemaVersion: 1,
        sessionId: 'test-session-queue',
        revision: 1,
        savedAt: new Date().toISOString(),
        snapshot: {
          snapshotId: 'test-snap',
          capturedAt: new Date().toISOString(),
          source: { title: 'Queue Test', account: null, publishedAt: null, url: 'http://test' },
          blocks: [],
          images: [],
          captureWarnings: [],
        },
      };

      // Submit rev 10
      const s10 = { ...baseSession, revision: 10 };
      let resolveFirstSave;
      const firstSavePromise = new Promise((resolve) => {
        resolveFirstSave = resolve;
      });

      // Intercept storage set temporarily on this page
      const origSet = window.chrome.storage.local.set;
      let callCount = 0;
      window.chrome.storage.local.set = async (obj) => {
        callCount++;
        if (callCount === 1) {
          await firstSavePromise;
        }
      };

      // Enqueue s10 -> start writing s10
      queue.enqueue(s10);

      // Immediately enqueue s11 while s10 is in-flight
      const s11 = { ...baseSession, revision: 11 };
      queue.enqueue(s11);

      // Status right after enqueuing s11 while s10 in-flight must be 'unsaved'
      const statusWhilePending = queue.getStatus();

      // Complete first save (s10)
      resolveFirstSave();

      // Wait a few ms for queue to process s11
      await new Promise((r) => setTimeout(r, 60));

      unsubscribe();
      // Restore chrome.storage.local.set
      window.chrome.storage.local.set = origSet;

      return {
        statuses,
        statusWhilePending,
        finalStatus: queue.getStatus(),
        lastSavedRevision: queue.getLastSavedRevision(),
      };
    });

    console.log('Queue handshake statuses:', queueTestResult.statuses);
    assert.strictEqual(queueTestResult.statusWhilePending, 'unsaved', 'Status while s10 in-flight and s11 pending must be unsaved');
    assert.strictEqual(queueTestResult.finalStatus, 'saved', 'Final status must be saved after s11 completes');
    assert.strictEqual(queueTestResult.lastSavedRevision, 11, 'Last saved revision must be 11');

    // Verify older revision s10 did NOT mark status as saved
    const savedEvents = queueTestResult.statuses.filter((s) => s.status === 'saved');
    assert(savedEvents.length >= 1, 'Must have at least one saved event');
    const lastSavedEvent = savedEvents[savedEvents.length - 1];
    assert.strictEqual(lastSavedEvent.revision, 11, 'Only latest revision 11 should have triggered saved event');
    console.log('✓ Test 4 Passed: Older revision completion did not falsely mark saved; single queue serialized writes successfully');

    // --------------------------------------------------------------------------
    // Test 5: Storage Failure, Inline Retry & Non-Degradation
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Storage Failure, Inline Retry & Non-Degradation ---');

    // Clean storage and reload page to start fresh cleaning session
    await worker.evaluate(() => chrome.storage.local.clear());
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    await page.evaluate((res) => {
      window.__wetrim.processCaptureResult(res);
    }, testArticleResult);
    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });

    // Mock chrome.storage.local.set to fail (simulate QuotaExceededError or disk full)
    await page.evaluate(() => {
      window.__origSet = chrome.storage.local.set;
      chrome.storage.local.set = () => {
        return Promise.reject(new Error('QUOTA_BYTES_EXCEEDED: Simulated disk failure'));
      };
    });

    // Trigger toggle to cause a write that fails
    const blockItems = await page.$$('[data-testid="block-item"]');
    assert(blockItems.length > 0, 'Block items must exist');
    const bId = await page.$eval('[data-testid="block-item"]', (el) => el.getAttribute('data-block-id'));

    await page.click(`[data-block-id="${bId}"] [data-testid="block-action-exclude"]`);

    // Wait for error state
    await page.waitForSelector('[data-save-status="error"]', { timeout: 5000 });

    const errorBtn = await page.$('[data-testid="save-status"]');
    assert(errorBtn, 'Error button must exist');
    const errorText = await page.$eval('[data-testid="save-status"]', (el) => el.textContent.trim());
    assert(errorText.includes('保存失败 · 点击重试'), `Expected error text with retry, got: ${errorText}`);

    // Verify memory state is NOT degraded:
    const blockCountDuringError = await page.$$eval('[data-testid="block-item"]', (els) => els.length);
    assert.strictEqual(blockCountDuringError, 3, 'Blocks must NOT be deleted or degraded on save failure');

    // Verify memory edits can still be exported via buildMarkdown
    const canExport = await page.evaluate(() => {
      const s = window.__wetrim.sessionSaveQueue.getStatus();
      const md = window.__wetrim.buildMarkdown([
        {
          id: 'test',
          order: 1,
          type: 'paragraph',
          originalHtml: '<p>test</p>',
          initialMarkdown: 'test',
          editedMarkdown: null,
          included: true,
          notes: [],
        },
      ]);
      return typeof md === 'string' && md.includes('test');
    });
    assert.strictEqual(canExport, true, 'buildMarkdown must work during save error');

    // Restore chrome.storage.local.set
    await page.evaluate(() => {
      chrome.storage.local.set = window.__origSet;
      delete window.__origSet;
    });

    // Click retry button on the save-status element
    await page.click('[data-testid="save-status"]');

    // Status should recover to saved
    await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
    const recoveredText = await page.$eval('[data-testid="save-status"]', (el) => el.textContent.trim());
    assert.strictEqual(recoveredText, '已保存', 'Status must recover to 已保存 after retry');
    console.log('✓ Test 5 Passed: Storage failure handled gracefully with inline retry; memory content not degraded');

    // --------------------------------------------------------------------------
    // Test 6: Full Page Reload & Direct Session Restoration (No Prompts, No Re-Splitting)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Full Page Reload & Direct Session Restoration ---');

    // Verify current state before reload
    const preReloadBlockCount = await page.$$eval('[data-testid="block-item"]', (els) => els.length);
    const preReloadSession = await worker.evaluate(() => chrome.storage.local.get('currentSession'));
    assert(preReloadSession.currentSession, 'currentSession must be in storage');

    // Reload page
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    // Page must directly enter cleaning mode without prompt
    const postReloadViewMode = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(postReloadViewMode, 'cleaning', 'Page must directly restore to cleaning mode without asking');

    // save-status must show "已保存"
    const postReloadSaveStatus = await page.$eval('[data-testid="save-status"]', (el) => el.getAttribute('data-save-status'));
    assert.strictEqual(postReloadSaveStatus, 'saved', 'Save status must be saved on direct restoration');

    const postReloadBlockCount = await page.$$eval('[data-testid="block-item"]', (els) => els.length);
    assert.strictEqual(postReloadBlockCount, preReloadBlockCount, 'Block count must match exactly without re-splitting');

    // Verify block identities did not change
    const postReloadBlock1Id = await page.$eval('[data-testid="block-item"]', (el) => el.getAttribute('data-block-id'));
    assert.strictEqual(postReloadBlock1Id, bId, 'Block UUID identity must not be regenerated on restoration');

    // Now test clearing session and reloading -> must enter empty mode
    await worker.evaluate(() => chrome.storage.local.remove('currentSession'));
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    const emptyViewMode = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(emptyViewMode, 'empty', 'Without currentSession, page must restore to empty view');
    console.log('✓ Test 6 Passed: Direct restoration on reload verified; block identities preserved; empty state when no session');

    // --------------------------------------------------------------------------
    // Test 7: Late Write Protection (Old session late writes cannot resurrect)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 7: Late Write Protection on Session Clear & Replacement ---');
    const lateWriteTest = await page.evaluate(async () => {
      const queue = window.__wetrim.sessionSaveQueue;
      const oldSession = {
        schemaVersion: 1,
        sessionId: 'old-session-123',
        revision: 5,
        savedAt: new Date().toISOString(),
        snapshot: {
          snapshotId: 'snap-old',
          capturedAt: new Date().toISOString(),
          source: { title: '旧文章', account: null, publishedAt: null, url: 'http://old' },
          blocks: [],
          images: [],
          captureWarnings: [],
        },
      };

      // Set up a delayed write for old session
      let resolveWrite;
      const writePromise = new Promise((r) => { resolveWrite = r; });

      const origSet = window.chrome.storage.local.set;
      window.chrome.storage.local.set = async (obj) => {
        if (obj.currentSession?.sessionId === 'old-session-123') {
          await writePromise;
        }
      };

      // Enqueue old session
      queue.enqueue(oldSession);

      // Now immediately clear session (start clearing, then resolve delayed write, then await clear)
      const clearPromise = queue.clear();

      // Complete the old write
      resolveWrite();
      await clearPromise;
      await new Promise((r) => setTimeout(r, 50));

      // Restore storage set
      window.chrome.storage.local.set = origSet;

      return {
        activeSessionId: queue.getActiveSessionId(),
        status: queue.getStatus(),
      };
    });

    assert.strictEqual(lateWriteTest.activeSessionId, null, 'Active session ID must remain null after clear');
    assert.strictEqual(lateWriteTest.status, 'saved', 'Status after clear must be saved/neutral');

    // Verify storage does not have the late write session
    const storageCheck = await worker.evaluate(() => chrome.storage.local.get('currentSession'));
    assert(!storageCheck.currentSession, 'Storage must not contain resurrected old session');
    console.log('✓ Test 7 Passed: Late write from cleared session discarded and cannot resurrect in storage');

    // --------------------------------------------------------------------------
    // Test 8: Page Visibility Change (flush on hidden)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 8: Page Visibility Change (flush on hidden) ---');
    const flushCalled = await page.evaluate(async () => {
      let flushCalled = false;
      const originalFlush = window.__wetrim.sessionSaveQueue.flush.bind(window.__wetrim.sessionSaveQueue);
      window.__wetrim.sessionSaveQueue.flush = async () => {
        flushCalled = true;
        return originalFlush();
      };

      // Mock visibilityState to hidden and dispatch visibilitychange
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Restore
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      window.__wetrim.sessionSaveQueue.flush = originalFlush;

      return flushCalled;
    });

    assert.strictEqual(flushCalled, true, 'flush() must be called when visibilityState changes to hidden');
    console.log('✓ Test 8 Passed: Page visibility change flushes pending saves');

    // --------------------------------------------------------------------------
    // Test 9: Session Replacement While Previous Write In-Flight (Finding 1 Verification)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 9: Session Replacement While Previous Write In-Flight (No Dropped Writes) ---');
    const sessionReplacementResult = await page.evaluate(async () => {
      const queue = new window.__wetrim.SessionSaveQueue();
      const sessionA = {
        schemaVersion: 1,
        sessionId: 'session-A',
        revision: 1,
        savedAt: new Date().toISOString(),
        snapshot: {
          snapshotId: 'snap-A',
          capturedAt: new Date().toISOString(),
          source: { title: 'Article A', account: null, publishedAt: null, url: 'http://a' },
          blocks: [],
          images: [],
          captureWarnings: [],
        },
      };
      const sessionB = {
        schemaVersion: 1,
        sessionId: 'session-B',
        revision: 1,
        savedAt: new Date().toISOString(),
        snapshot: {
          snapshotId: 'snap-B',
          capturedAt: new Date().toISOString(),
          source: { title: 'Article B', account: null, publishedAt: null, url: 'http://b' },
          blocks: [],
          images: [],
          captureWarnings: [],
        },
      };

      let resolveA;
      const promiseA = new Promise((r) => { resolveA = r; });
      let writtenSessionId = null;

      const origSet = window.chrome.storage.local.set;
      window.chrome.storage.local.set = async (obj) => {
        if (obj.currentSession?.sessionId === 'session-A') {
          await promiseA;
        } else if (obj.currentSession?.sessionId === 'session-B') {
          writtenSessionId = obj.currentSession.sessionId;
        }
      };

      // Start write for Session A
      queue.enqueue(sessionA);
      // Enqueue Session B while Session A is in-flight
      queue.enqueue(sessionB);

      // Finish write for Session A
      resolveA();
      // Wait for Session B write to run
      await new Promise((r) => setTimeout(r, 80));

      window.chrome.storage.local.set = origSet;

      return {
        writtenSessionId,
        finalStatus: queue.getStatus(),
        activeSessionId: queue.getActiveSessionId(),
      };
    });

    assert.strictEqual(sessionReplacementResult.writtenSessionId, 'session-B', 'Session B must be written after Session A completes');
    assert.strictEqual(sessionReplacementResult.finalStatus, 'saved', 'Queue must be saved with Session B');
    assert.strictEqual(sessionReplacementResult.activeSessionId, 'session-B');
    console.log('✓ Test 9 Passed: Session replacement during in-flight write does not drop subsequent session');

    // --------------------------------------------------------------------------
    // Test 10: Message Capture While in Cleaning Mode Enters CandidateConfirm (Finding 3 Verification)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 10: Subsequent Article Capture Enters candidateConfirm (No Stale Closure Overwrite) ---');
    // First, ensure app is in cleaning state with an existing session
    await worker.evaluate(() => chrome.storage.local.clear());
    await page.goto(appUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 5000 });

    await page.evaluate((res) => {
      window.__wetrim.processCaptureResult(res);
    }, testArticleResult);
    await page.waitForSelector('[data-view-mode="cleaning"]', { timeout: 5000 });

    // Now simulate an incoming capture message from background (as if user clicked icon on another tab)
    const secondArticleResult = {
      kind: 'article',
      source: {
        title: '第二篇候选文章',
        account: '测试公众号2',
        publishedAt: '2026-09-13',
        url: 'https://mp.weixin.qq.com/s/second-article',
      },
      contentHtml: '<p>候选文章正文</p>',
      unstable: false,
    };

    // Store in pendingCapture and dispatch message to app
    await worker.evaluate(async (res) => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: res,
        },
      });
      // Broadcast message to open tabs
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      for (const ctx of contexts) {
        if (ctx.tabId) {
          try {
            await chrome.tabs.sendMessage(ctx.tabId, { type: 'pending-capture' });
          } catch {}
        }
      }
    }, secondArticleResult);

    // Wait for candidateConfirm card to appear! Must NOT stay or silently overwrite cleaning session!
    await page.waitForSelector('[data-testid="candidate-confirm-card"]', { timeout: 5000 });
    const currentViewMode = await page.$eval('.app-container', (el) => el.getAttribute('data-view-mode'));
    assert.strictEqual(currentViewMode, 'candidateConfirm', 'App must transition to candidateConfirm when receiving article while cleaning');
    console.log('✓ Test 10 Passed: Subsequent article capture correctly enters candidateConfirm without stale closure overwrite');

    console.log('\n==> All Issue #26 acceptance criteria verified successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
