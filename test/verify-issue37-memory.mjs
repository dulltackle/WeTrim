// 真实图片联网复核单独运行，不把外网波动混入文字性能预算。
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const fixture = JSON.parse(fs.readFileSync('test/fixtures/wetrim-sample-deep-longform.json', 'utf8'));
const browser = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:true, enableExtensions:[path.resolve('dist')], args:['--no-sandbox'] });
function rss(pid) {
  try {
    const own = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    return own + children.reduce((sum, child) => sum + rss(child), 0);
  } catch { return 0; }
}
try {
  const target = await browser.waitForTarget(t=>t.type()==='service_worker');
  const worker = await target.worker();
  const id = await worker.evaluate(()=>chrome.runtime.id);
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:900});
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await cdp.send('Performance.enable');
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForFunction(()=>window.__wetrim?.getState().viewMode==='empty');
  const report = { chrome:await browser.version(), cpuRate:4, baselineRssKiB:rss(browser.process().pid), passes:[] };
  await page.evaluate(f=>window.__wetrim.processCaptureResult({kind:'article',source:{title:f.title,url:f.sourceUrl,account:null,publishedAt:null},unstable:false,contentHtml:f.RESULTS.content.after.html}),fixture);
  await page.waitForSelector('[data-testid="block-item"]');
  for (let pass=0;pass<3;pass++) {
    const images = await page.$$('[data-testid="image-thumbnail-img"]');
    assert.equal(images.length,6);
    for (const img of images) {
      await img.scrollIntoView();
      await page.waitForFunction(el=>el.complete && el.naturalWidth>0,{timeout:30000},img);
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const {metrics} = await cdp.send('Performance.getMetrics');
    const dimensions = await page.$$eval('[data-testid="image-thumbnail-img"]',imgs=>imgs.map(img=>[img.naturalWidth,img.naturalHeight]));
    assert(dimensions.every(([w,h])=>w>140&&h>140),'不能把防盗链小图当成真实图片');
    report.passes.push({rssKiB:rss(browser.process().pid),heapBytes:metrics.find(m=>m.name==='JSHeapUsedSize').value,dimensions});
    await page.evaluate(()=>window.scrollTo(0,0));
  }
  fs.writeFileSync('/tmp/wetrim-issue37-memory.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); }
