import {launchChrome} from './chrome.mjs';
import {feishuFixture} from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
const profile=await mkdtemp(path.join(os.tmpdir(),'wetrim-issue66-'));
const server=feishuFixture();let browser,page,id;
async function launch(first=false){
 browser=await launchChrome({headless:true,userDataDir:profile,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();const current=await worker.evaluate(()=>chrome.runtime.id);if(id)assert.equal(current,id);id=current;
 for(const tab of await browser.pages())await tab.close();page=await browser.newPage();page.setDefaultTimeout(10000);await server.install(page);
 await page.goto(`chrome-extension://${id}/app.html`);await page.waitForSelector('[data-view-mode]');await server.seed(page,first);
}
const local=()=>page.evaluate(()=>chrome.storage.local.get(null));
const status=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-status]')?.textContent.includes(text),{},text);
const testStatus=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-test-status]')?.textContent.includes(text)&&!document.querySelector('[data-feishu-test-retry]').disabled,{},text);
const saveStatus=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-save-status]')?.textContent.includes(text)&&!document.querySelector('[data-feishu-retry]').disabled,{},text);
const input=async(selector,value)=>page.$eval(selector,(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
async function connect(code){await input('#feishu-url','https://example.feishu.cn/base/appFixture?table=tblFixture');await input('#feishu-token',code);await page.click('[data-feishu-check]');await status('连接检查通过');await page.click('[data-feishu-confirm]');await status('连接已保存');}
async function clear(){await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');}
try{
 await launch(true);
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'最终组合文章',account:'测试',publishedAt:'2026-10-08',url:'https://mp.weixin.qq.com/s/final-combination'},contentHtml:'<p>清洗保留</p>',unstable:false}));
 await page.waitForSelector('[data-feishu-save]');await page.waitForSelector('[data-save-status="saved"]');const cleaning=(await local()).currentSession;
 await page.click('[data-feishu-settings]');
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 server.onUpload=async()=>{server.onUpload=null;entered();await gate;};
 await page.click('[data-feishu-test-start]');await started;await clear();release();
 await page.waitForFunction(()=>!document.querySelector('[data-feishu-test-retry]').disabled);
 assert.equal((await local()).feishuSave,undefined);assert.equal((await local()).feishuConnection,undefined);assert.deepEqual((await local()).currentSession,cleaning);
 assert.equal(server.records.length,1);assert.equal(server.records[0].fields['保存状态'],'未完成');assert.equal(server.records[0].fields['图片']?.length??0,0);assert.equal(server.uploads.size,1);
 assert.equal(await page.$('[data-feishu-test-link]'),null);
 console.log('✓ 测试保存上传回执迟到后清除：远端正文/已上传素材保留，不继续关联或误报完成，本地连接与恢复不复活');
 await connect('combination-before-rotation');server.imageFault='associateReject';await page.click('[data-feishu-test-start]');await testStatus('飞书拒绝');
 const count=server.records.length,uploads=server.uploadCount,group=server.records.at(-1).fields['文章关联标识'];
 await connect('combination-after-rotation');await browser.close();await launch();await page.click('[data-feishu-settings]');
 await page.click('[data-feishu-test-retry]');await testStatus('正文与图片写入通过');
 assert.equal(server.records.length,count);assert.equal(server.uploadCount,uploads);assert.equal(server.records.at(-1).fields['文章关联标识'],group);assert.equal(server.records.at(-1).fields['保存状态'],'已完成');assert.equal(server.records.at(-1).fields['图片'].length,1);assert.deepEqual((await local()).currentSession,cleaning);
 console.log('✓ 测试保存关联失败→同目标换码→完整浏览器重启：复用旧记录/图片回执并核对完成');
 await page.click('[data-feishu-settings]');
 await page.$eval('[data-block-order="1"] [data-testid="block-action-edit"]',el=>el.scrollIntoView({block:'center'}));await page.click('[data-block-order="1"] [data-testid="block-action-edit"]');
 const full='甲'.repeat(85000)+'\n\n'+'乙'.repeat(85000);
 await page.$eval('[data-block-order="1"] textarea',(el,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},full);
 await page.click('[data-block-order="1"] [data-testid="block-action-finish-edit"]');
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-new]');await page.type('[data-feishu-tags-new]','组合标签');await page.click('[data-feishu-tags-apply]');await page.waitForSelector('[data-save-status="saved"]');const edited=(await local()).currentSession;
 let releasePart,enteredPart;const partGate=new Promise(r=>releasePart=r),partStarted=new Promise(r=>enteredPart=r);const offset=server.records.length;
 server.onWrite=async()=>{if(server.records.length===offset+2){server.onWrite=null;enteredPart();await partGate;}};
 await page.click('[data-feishu-save]');await partStarted;await page.click('[data-feishu-settings]');await clear();releasePart();await page.waitForFunction(()=>!document.querySelector('[data-feishu-retry]').disabled);
 const parts=server.records.slice(offset);assert.equal(parts.length,2);assert.equal(parts.map(r=>r.fields['正文']).join(''),full);assert(parts.every(r=>r.fields['保存状态']==='未完成'));assert(parts.every(r=>JSON.stringify(r.fields['标签'])===JSON.stringify(['组合标签'])));assert.equal(parts[0].fields['文章关联标识'],parts[1].fields['文章关联标识']);
 assert.equal((await local()).feishuSave,undefined);assert.deepEqual((await local()).currentSession,edited);
 await browser.close();await launch();assert.equal((await local()).feishuSave,undefined);assert.equal((await local()).feishuConnection,undefined);assert.deepEqual((await local()).currentSession,edited);
 console.log('✓ 多篇标签保存后篇回执迟到→清除→完整重启：两篇远端保留未完成，清洗保留，旧进度不复活');
}finally{if(browser?.connected)await browser.close();}
