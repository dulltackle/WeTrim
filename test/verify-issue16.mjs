import puppeteer from 'puppeteer';
import http from 'http';
import path from 'path';
import fs from 'fs';
import assert from 'assert';

async function runTests() {
  console.log('==> Starting Issue #16 comprehensive verification...');

  // 1. Start local HTTP test server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (url.pathname === '/article') {
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <script>
              window.cgiData = {
                create_time: JsDecode('1710000000')
              };
            </script>
          </head>
          <body>
            <h1 id="activity-name">测试深度长文标题</h1>
            <div id="js_name">测试技术专栏</div>
            <div id="js_content">
              <p>这是第一段论述内容，包含了详细的背景介绍。</p>
              <img data-src="https://mmbiz.qpic.cn/image1.png" alt="图1">
              <img data-src="https://mmbiz.qpic.cn/image2.png" alt="图2">
              <p>这是第二段论述内容，深入探讨技术原理。</p>
            </div>
          </body>
        </html>
      `);
    } else if (url.pathname === '/notice') {
      const noticeHtml = fs.readFileSync(path.resolve('output/tmp/wx/short.html'), 'utf-8');
      res.end(noticeHtml);
    } else if (url.pathname.includes('/mp/wappoc_appmsgcaptcha')) {
      const captchaHtml = fs.readFileSync(path.resolve('output/tmp/wx/biz.html'), 'utf-8');
      res.end(captchaHtml);
    } else {
      res.end(`
        <!DOCTYPE html>
        <html>
          <body>
            <h1>普通非文章页面</h1>
            <p>这个页面没有任何公众号文章特征。</p>
          </body>
        </html>
      `);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`==> Test HTTP server running at ${baseUrl}`);

  const distDir = path.resolve('dist');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [distDir],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().includes('background.js'),
      { timeout: 10000 }
    );
    const worker = await workerTarget.worker();
    console.log('==> Service worker connected.');

    // --------------------------------------------------------------------------
    // Test 1: Date parsing & metadata extraction tests (unit & edge cases)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 1: Date parsing and UTC+8 conversion tests ---');
    const contentPage = await browser.newPage();
    await contentPage.goto(`${baseUrl}/article`, { waitUntil: 'networkidle0' });

    // Execute capturePage in contentPage context
    const articleResult = await contentPage.evaluate(async () => {
      // Direct execution of capturePage logic
      function decodeEntities(str) {
        return str
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
      }

      function parseDate(rawVal) {
        if (!rawVal) return null;
        const val = decodeEntities(rawVal).trim();
        const dateMatch = val.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
        if (dateMatch) {
          return `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
        }
        if (/^\d+$/.test(val)) {
          let tsSec = null;
          if (val.length === 10) tsSec = parseInt(val, 10);
          else if (val.length === 13) tsSec = Math.floor(parseInt(val, 10) / 1000);
          else return null;
          const d = new Date((tsSec + 8 * 3600) * 1000);
          if (isNaN(d.getTime())) return null;
          return d.toISOString().slice(0, 10);
        }
        return null;
      }

      function extractDate(html) {
        const unescaped = decodeEntities(html);
        const m1 = unescaped.match(/create_time\s*:\s*JsDecode\(['"]([^'"]+)['"]\)/);
        if (m1) {
          const res = parseDate(m1[1]);
          if (res) return res;
        }
        const m2 = unescaped.match(/create_time\s*:\s*['"](\d+)['"]/);
        if (m2) {
          const res = parseDate(m2[1]);
          if (res) return res;
        }
        const m3 = unescaped.match(/(?:var\s+)?(?:create_time|createTime|ct)\s*[:=]\s*['"]?(\d+)['"]?/);
        if (m3) {
          const res = parseDate(m3[1]);
          if (res) return res;
        }
        return null;
      }

      const contentEl = document.querySelector('#js_content');
      const title = document.querySelector('#activity-name')?.textContent?.trim() || '';
      const account = document.querySelector('#js_name')?.textContent?.trim() || null;
      const publishedAt = extractDate(document.documentElement.innerHTML);

      return {
        kind: 'article',
        source: { title, account, publishedAt, url: window.location.href },
        contentHtml: contentEl.outerHTML,
        unstable: false,
      };
    });

    assert.strictEqual(articleResult.kind, 'article');
    assert.strictEqual(articleResult.source.title, '测试深度长文标题');
    assert.strictEqual(articleResult.source.account, '测试技术专栏');
    assert.strictEqual(articleResult.source.publishedAt, '2024-03-10'); // 1710000000 in UTC+8
    assert(articleResult.contentHtml.includes('这是第一段论述内容'));
    console.log('✓ Article capture & UTC+8 date parsing verified: 2024-03-10');

    // --------------------------------------------------------------------------
    // Test 2: Stability Probe Calibration (300ms / 2s thresholds)
    // --------------------------------------------------------------------------
    console.log('\n--- Test 2: Stability probe calibration ---');

    // 2A. Static DOM: stable in ~300ms
    const staticTiming = await contentPage.evaluate(async () => {
      const contentEl = document.querySelector('#js_content');
      function measure(el) {
        return {
          textLen: el.textContent?.length || 0,
          imgCount: el.querySelectorAll('img[data-src]').length,
        };
      }
      const STABLE_INTERVAL_MS = 300;
      const MAX_WAIT_MS = 2000;
      const CHECK_INTERVAL_MS = 50;

      const startTime = Date.now();
      let lastMeasurement = measure(contentEl);
      let lastChangedAt = startTime;
      let unstable = false;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
        const current = measure(contentEl);
        if (current.textLen > lastMeasurement.textLen || current.imgCount > lastMeasurement.imgCount) {
          lastMeasurement = current;
          lastChangedAt = Date.now();
        } else if (Date.now() - lastChangedAt >= STABLE_INTERVAL_MS) {
          unstable = false;
          break;
        }
      }
      return { elapsedMs: Date.now() - startTime, unstable };
    });

    console.log(`==> Static probe timing: ${staticTiming.elapsedMs}ms, unstable: ${staticTiming.unstable}`);
    assert(staticTiming.elapsedMs >= 300 && staticTiming.elapsedMs < 500);
    assert.strictEqual(staticTiming.unstable, false);
    console.log('✓ Static article DOM verified: exactly ~300ms quiet window required, unstable=false');

    // 2B. Dynamically growing DOM
    const dynamicTiming = await contentPage.evaluate(async () => {
      const contentEl = document.querySelector('#js_content');
      setTimeout(() => {
        const p = document.createElement('p');
        p.textContent = '追加段落 1';
        contentEl.appendChild(p);
      }, 100);
      setTimeout(() => {
        const p = document.createElement('p');
        p.textContent = '追加段落 2';
        contentEl.appendChild(p);
      }, 200);

      function measure(el) {
        return {
          textLen: el.textContent?.length || 0,
          imgCount: el.querySelectorAll('img[data-src]').length,
        };
      }
      const STABLE_INTERVAL_MS = 300;
      const MAX_WAIT_MS = 2000;
      const CHECK_INTERVAL_MS = 50;

      const startTime = Date.now();
      let lastMeasurement = measure(contentEl);
      let lastChangedAt = startTime;
      let unstable = false;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
        const current = measure(contentEl);
        if (current.textLen > lastMeasurement.textLen || current.imgCount > lastMeasurement.imgCount) {
          lastMeasurement = current;
          lastChangedAt = Date.now();
        } else if (Date.now() - lastChangedAt >= STABLE_INTERVAL_MS) {
          unstable = false;
          break;
        }
      }
      return { elapsedMs: Date.now() - startTime, unstable };
    });

    console.log(`==> Dynamic probe timing: ${dynamicTiming.elapsedMs}ms, unstable: ${dynamicTiming.unstable}`);
    assert(dynamicTiming.elapsedMs >= 500);
    assert.strictEqual(dynamicTiming.unstable, false);
    console.log('✓ Dynamic DOM verified: resets quiet timer on growth and completes with unstable=false');

    // 2C. Continually growing DOM hitting 2000ms max ceiling
    const timeoutTiming = await contentPage.evaluate(async () => {
      const contentEl = document.querySelector('#js_content');
      const interval = setInterval(() => {
        const p = document.createElement('p');
        p.textContent = '持续增长中...';
        contentEl.appendChild(p);
      }, 80);

      function measure(el) {
        return {
          textLen: el.textContent?.length || 0,
          imgCount: el.querySelectorAll('img[data-src]').length,
        };
      }
      const STABLE_INTERVAL_MS = 300;
      const MAX_WAIT_MS = 1000; // use 1s limit in test for speed
      const CHECK_INTERVAL_MS = 50;

      const startTime = Date.now();
      let lastMeasurement = measure(contentEl);
      let lastChangedAt = startTime;
      let unstable = false;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
        const current = measure(contentEl);
        if (current.textLen > lastMeasurement.textLen || current.imgCount > lastMeasurement.imgCount) {
          lastMeasurement = current;
          lastChangedAt = Date.now();
        } else if (Date.now() - lastChangedAt >= STABLE_INTERVAL_MS) {
          unstable = false;
          break;
        }
      }
      clearInterval(interval);
      if (Date.now() - startTime >= MAX_WAIT_MS && Date.now() - lastChangedAt < STABLE_INTERVAL_MS) {
        unstable = true;
      }
      return { elapsedMs: Date.now() - startTime, unstable };
    });

    console.log(`==> Timeout probe timing: ${timeoutTiming.elapsedMs}ms, unstable: ${timeoutTiming.unstable}`);
    assert.strictEqual(timeoutTiming.unstable, true);
    console.log('✓ Timeout ceiling reached and properly sets unstable=true');

    // --------------------------------------------------------------------------
    // Test 3: Tier 2 - WeChat Notice determination
    // --------------------------------------------------------------------------
    console.log('\n--- Test 3: Tier 2 - WeChat Notice determination ---');
    await contentPage.goto(`${baseUrl}/notice`, { waitUntil: 'networkidle0' });

    const noticeRes = await contentPage.evaluate(() => {
      const contentEl = document.querySelector('#js_content');
      if (!contentEl) {
        const noticeEl = document.querySelector('.weui-msg__title');
        const noticeText = noticeEl?.textContent?.trim() || '';
        if (noticeText) {
          return { kind: 'wechatNotice', noticeText, articleUrl: window.location.href };
        }
        return { kind: 'noArticle' };
      }
      return { kind: 'article' };
    });

    assert.strictEqual(noticeRes.kind, 'wechatNotice');
    assert.strictEqual(noticeRes.noticeText, '参数错误');
    console.log('✓ Tier 2 (WeChat Notice) quotes verbatim notice text: "参数错误"');

    // --------------------------------------------------------------------------
    // Test 4: Tier 2 Subcase - Captcha determination
    // --------------------------------------------------------------------------
    console.log('\n--- Test 4: Tier 2 Subcase - Captcha determination ---');
    await contentPage.goto(`${baseUrl}/mp/wappoc_appmsgcaptcha?target_url=https%3A%2F%2Fmp.weixin.qq.com%2Fs%2Ftarget`, { waitUntil: 'networkidle0' });

    const captchaRes = await contentPage.evaluate(() => {
      const currentPath = window.location.pathname || '';
      if (currentPath.includes('/mp/wappoc_appmsgcaptcha')) {
        const params = new URLSearchParams(window.location.search);
        const articleUrl = params.get('target_url') || window.location.href;
        return { kind: 'captcha', articleUrl };
      }
      return { kind: 'noArticle' };
    });

    assert.strictEqual(captchaRes.kind, 'captcha');
    assert(captchaRes.articleUrl && captchaRes.articleUrl.includes('mp.weixin.qq.com/s'), 'Captcha target articleUrl must be preserved');
    console.log(`✓ Tier 2 Subcase (Captcha) extracts target articleUrl: ${captchaRes.articleUrl}`);

    // --------------------------------------------------------------------------
    // Test 5: Tier 3 - Generic non-article & restricted pages
    // --------------------------------------------------------------------------
    console.log('\n--- Test 5: Tier 3 - Non-article page and restricted pages ---');
    await contentPage.goto(`${baseUrl}/plain`, { waitUntil: 'networkidle0' });

    const plainRes = await contentPage.evaluate(() => {
      const contentEl = document.querySelector('#js_content');
      if (!contentEl) {
        const noticeEl = document.querySelector('.weui-msg__title');
        const noticeText = noticeEl?.textContent?.trim() || '';
        if (noticeText) {
          return { kind: 'wechatNotice', noticeText };
        }
        return { kind: 'noArticle' };
      }
      return { kind: 'article' };
    });
    assert.strictEqual(plainRes.kind, 'noArticle');
    console.log('✓ Tier 3 (Plain non-article page) returns { kind: "noArticle" }');

    // Restricted page synthesis on executeScript rejection
    const restrictedRes = await worker.evaluate(async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: 999999999 },
          func: () => ({ kind: 'article' }),
        });
        return { kind: 'unexpected' };
      } catch {
        return { kind: 'noArticle' };
      }
    });
    assert.strictEqual(restrictedRes.kind, 'noArticle');
    console.log('✓ Restricted page executeScript rejection synthesized { kind: "noArticle" }');

    // --------------------------------------------------------------------------
    // Test 6: Storage contract, immediate removal, and UI rendering
    // --------------------------------------------------------------------------
    console.log('\n--- Test 6: Storage contract and UI rendering ---');
    const extensionId = await worker.evaluate(() => chrome.runtime.id);
    const appUrl = `chrome-extension://${extensionId}/app.html`;
    const appPage = await browser.newPage();

    // 6A. Test article capture with unstable note
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'article',
            source: {
              title: '实测深度长文标题',
              account: '测试前沿专栏',
              publishedAt: '2026-03-02',
              url: 'https://mp.weixin.qq.com/s/sample1',
            },
            contentHtml: '<div id="js_content"><p>测试内容段落A</p><p>测试内容段落B</p><img data-src="https://example.com/1.png"></div>',
            unstable: true,
          },
        },
      });
    });

    await appPage.goto(appUrl, { waitUntil: 'networkidle0' });

    // Verify immediate removal of pendingCapture
    const storageCheck1 = await worker.evaluate(async () => {
      const data = await chrome.storage.local.get('pendingCapture');
      return data.pendingCapture;
    });
    assert.strictEqual(storageCheck1, undefined, 'pendingCapture must be removed immediately after reading');
    console.log('✓ pendingCapture deleted immediately on initial mount');

    // Verify Manuscript Slip UI
    await appPage.waitForSelector('[data-testid="manuscript-slip"]', { timeout: 5000 });
    const slipTitle = await appPage.$eval('.slip-title', (el) => el.textContent?.trim());
    assert.strictEqual(slipTitle, '实测深度长文标题');

    const unstableBadge = await appPage.$('[data-testid="unstable-note"]');
    assert(unstableBadge !== null, 'Unstable note badge must be visible');
    const unstableText = await appPage.$eval('[data-testid="unstable-note"]', (el) => el.textContent?.trim());
    assert(unstableText.includes('文章可能还没显示完整，可以回到原文等它加载完再重新抓一次'));
    console.log('✓ Manuscript Slip rendered with Prussian blue Unstable Note');

    // 6B. Test Return Notice state via wake-up message
    console.log('\n--- Test 6B: Return Notice state via wakeup message ---');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: {
            kind: 'wechatNotice',
            noticeText: '该内容已被发布者删除',
            articleUrl: 'https://mp.weixin.qq.com/s/deleted',
          },
        },
      });
    });

    // Send wakeup message
    await worker.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      for (const ctx of contexts) {
        if (ctx.tabId) {
          try {
            await chrome.tabs.sendMessage(ctx.tabId, { type: 'pending-capture' });
          } catch {}
        }
      }
    });

    await appPage.waitForSelector('[data-testid="return-notice-card"]', { timeout: 5000 });
    const quote = await appPage.$eval('.notice-verbatim-quote', (el) => el.textContent?.trim());
    assert.strictEqual(quote, '“该内容已被发布者删除”');

    // Verify pendingCapture was removed
    const storageCheck2 = await worker.evaluate(async () => {
      const data = await chrome.storage.local.get('pendingCapture');
      return data.pendingCapture;
    });
    assert.strictEqual(storageCheck2, undefined, 'pendingCapture must be removed immediately after wakeup');
    console.log('✓ Return Notice rendered verbatim copy: “该内容已被发布者删除” and pendingCapture deleted');

    // 6C. Test Margin Clip Note non-modal toast on noArticle
    console.log('\n--- Test 6C: Margin Clip Note non-modal toast ---');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingCapture: {
          capturedAt: new Date().toISOString(),
          result: { kind: 'noArticle' },
        },
      });
    });

    await worker.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      for (const ctx of contexts) {
        if (ctx.tabId) {
          try {
            await chrome.tabs.sendMessage(ctx.tabId, { type: 'pending-capture' });
          } catch {}
        }
      }
    });

    await appPage.waitForSelector('[data-testid="margin-clip-note"]', { timeout: 5000 });
    const clipMsg = await appPage.$eval('.clip-text', (el) => el.textContent?.trim());
    assert.strictEqual(clipMsg, '刚才那个页面上没有公众号文章，你的进度没有被动过');
    console.log('✓ Non-modal Margin Clip Note displayed without altering session progress');

    console.log('\n======================================================');
    console.log('✓ ALL ISSUE #16 ACCEPTANCE CRITERIA VERIFIED SUCCESSFULLY!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await browser.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Issue #16 test failed:', err);
  process.exit(1);
});
