import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// 四个 PR 浏览器入口共享选择与取证；使用完整版 Chrome，加载失败会直接抛错。
export async function launchChrome(options) {
  const browser = await puppeteer.launch({ ...options, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
  const close = browser.close.bind(browser);
  browser.close = async () => {
    try {
      const directory = path.resolve(process.env.WETRIM_ARTIFACTS || 'artifacts/pr', path.basename(process.argv[1], '.mjs'));
      await mkdir(directory, { recursive: true });
      for (const [index, page] of (await browser.pages()).entries()) {
        if (page.url().startsWith('chrome-extension://')) {
          await page.screenshot({ path: path.join(directory, `page-${index}.png`) }).catch(error => console.error('截图失败：', error.message));
        }
      }
    } finally { await close(); }
  };
  return browser;
}
