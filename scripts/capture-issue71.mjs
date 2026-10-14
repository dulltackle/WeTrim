import { launchChrome } from '../test/chrome.mjs';
import path from 'path';
import fs from 'fs';

const distDir = path.resolve('dist');
const browser = await launchChrome({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  enableExtensions: [distDir],
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const outDir = path.resolve('artifacts/issue71');
fs.mkdirSync(outDir, { recursive: true });

try {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().includes('background.js')
  );
  const worker = await workerTarget.worker();
  const extId = await worker.evaluate(() => chrome.runtime.id);
  const appUrl = `chrome-extension://${extId}/app.html`;

  const page = await browser.newPage();
  
  // 1. Wide window (1280x800) - Closed state
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(appUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('summary[data-feishu-settings]');
  await page.screenshot({ path: path.join(outDir, '01-wide-closed.png') });

  // 2. Wide window - Open state
  await page.click('summary[data-feishu-settings]');
  await page.waitForSelector('#feishu-url');
  await page.screenshot({ path: path.join(outDir, '02-wide-open.png') });

  // 3. Narrow window (480x800) - Open state
  await page.setViewport({ width: 480, height: 800 });
  await page.screenshot({ path: path.join(outDir, '03-narrow-open.png') });

  // 4. Keyboard focus test
  await page.focus('#feishu-url');
  await page.screenshot({ path: path.join(outDir, '04-focus-input.png') });
  await page.keyboard.press('Tab'); // focuses #feishu-token
  await page.screenshot({ path: path.join(outDir, '05-focus-token.png') });
  await page.keyboard.press('Tab'); // focuses [data-feishu-check] button
  await page.screenshot({ path: path.join(outDir, '06-focus-check-btn.png') });

  console.log('Screenshots captured successfully in', outDir);
} finally {
  await browser.close();
}
