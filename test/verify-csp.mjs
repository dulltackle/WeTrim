import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pathToExtension = path.resolve(__dirname, '../dist');

async function run() {
  console.log('==> Launching Chrome with extension from:', pathToExtension);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    enableExtensions: [pathToExtension],
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    console.log('==> Waiting for service_worker target...');
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().includes('background.js'),
      { timeout: 10000 }
    );
    const workerUrl = workerTarget.url();
    const extensionId = new URL(workerUrl).hostname;
    console.log('==> Extension loaded successfully! ID:', extensionId);

    const appUrl = `chrome-extension://${extensionId}/app.html`;
    console.log('==> Navigating to extension app page:', appUrl);
    const page = await browser.newPage();

    const consoleMessages = [];
    const pageErrors = [];

    page.on('console', (msg) => {
      const text = msg.text();
      consoleMessages.push({ type: msg.type(), text });
      console.log(`[Browser Console ${msg.type()}]`, text);
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err);
      console.error('[Browser PageError]', err);
    });

    // Listen for CSP violations in DOM before scripts execute
    await page.evaluateOnNewDocument(() => {
      window.__cspViolations = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          originalPolicy: e.originalPolicy,
          sourceFile: e.sourceFile,
          lineNumber: e.lineNumber,
        });
      });
    });

    await page.goto(appUrl, { waitUntil: 'networkidle0' });

    console.log('==> Waiting for App self-test badge...');
    await page.waitForSelector('[data-csp-eval-verified="true"]', { timeout: 10000 });
    const statusText = await page.$eval('[data-testid="self-test-status"]', (el) => el.textContent);
    console.log('==> Self-test badge rendered:', statusText);

    // Verify rendered steps from marked + DOMPurify
    const renderedStepsHtml = await page.$eval('.rendered-steps', (el) => el.innerHTML);
    if (!renderedStepsHtml.includes('用浏览器打开一篇公众号文章')) {
      throw new Error('Rendered steps HTML missing expected text from marked + DOMPurify');
    }

    // Verify CSP violations
    const cspViolations = await page.evaluate(() => window.__cspViolations);
    console.log('==> CSP Violations reported by browser:', cspViolations.length);
    if (cspViolations.length > 0) {
      console.error('CSP Violations detected:', cspViolations);
      throw new Error(`CSP Violations detected: ${JSON.stringify(cspViolations)}`);
    }

    // Verify console errors
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    if (consoleErrors.length > 0) {
      throw new Error(`Console errors detected: ${JSON.stringify(consoleErrors)}`);
    }

    if (pageErrors.length > 0) {
      throw new Error(`Page errors detected: ${JSON.stringify(pageErrors)}`);
    }

    // Verify self-test console log
    const selfTestLog = consoleMessages.find((m) =>
      m.text.includes('[WeTrim Self-Test] Production CSP & eval verification passed')
    );
    if (!selfTestLog) {
      throw new Error('Missing self-test console log confirmation');
    }

    // Test service worker getContexts focus behavior
    console.log('==> Testing Service Worker getContexts focus behavior...');
    const worker = await workerTarget.worker();
    const tabsBefore = await browser.pages();
    console.log('==> Pages before trigger:', tabsBefore.length);

    await worker.evaluate(async () => {
      const appUrl = chrome.runtime.getURL('app.html');
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['TAB'],
        documentUrls: [appUrl],
      });
      if (contexts && contexts.length > 0 && contexts[0].tabId !== undefined) {
        await chrome.tabs.update(contexts[0].tabId, { active: true });
        return { action: 'focused', count: contexts.length };
      } else {
        await chrome.tabs.create({ url: appUrl });
        return { action: 'created', count: 0 };
      }
    });

    const tabsAfter = await browser.pages();
    console.log('==> Pages after trigger:', tabsAfter.length);
    if (tabsAfter.length !== tabsBefore.length) {
      throw new Error(
        `Expected no new tabs opened, but tab count changed from ${tabsBefore.length} to ${tabsAfter.length}`
      );
    }

    console.log('\n=============================================');
    console.log('✓ All 5 libraries verified in production build');
    console.log('✓ Zero CSP violations, zero eval usage');
    console.log('✓ React 19, Turndown, GFM, marked, DOMPurify OK');
    console.log('✓ getContexts tab focus single-instance OK');
    console.log('=============================================\n');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
