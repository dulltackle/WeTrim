import {launchChrome} from './chrome.mjs';
import {feishuFixture} from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser=await launchChrome({headless:true,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
try{
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
 const page=await browser.newPage();await page.setViewport({width:800,height:600});page.setDefaultTimeout(10000);const server=feishuFixture();await server.install(page);
 await page.goto(`chrome-extension://${await worker.evaluate(()=>chrome.runtime.id)}/app.html`);await page.waitForSelector('[data-view-mode="empty"]');await server.seed(page);
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'含图文章',account:null,publishedAt:null,url:'https://mp.weixin.qq.com/s/images'},contentHtml:'<p>正文</p>',unstable:false}));
 await page.waitForSelector('[data-feishu-save]');
 const status=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-save-status]').textContent.includes(text)&&!document.querySelector('[data-feishu-save]').disabled,{},text);
 const edit=async value=>{await page.$eval('[data-block-order="1"] [data-testid="block-action-edit"]',el=>el.scrollIntoView({block:'center'}));assert(await page.$eval('[data-block-order="1"] [data-testid="block-action-edit"]',el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'滚动后真实编辑按钮可命中');await page.click('[data-block-order="1"] [data-testid="block-action-edit"]');await page.waitForSelector('[data-block-order="1"] textarea');await page.$eval('[data-block-order="1"] textarea',(el,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);await page.click('[data-block-order="1"] [data-testid="block-action-finish-edit"]');};
 const body='正文\n\n![图](https://mmbiz.qpic.cn/one.png)\n\n- ![列表][same]\n\n> ![引用](https://mmbiz.qpic.cn/one.png)\n\n[same]: https://mmbiz.qpic.cn/one.png\n\n```\n![伪图片](https://mmbiz.qpic.cn/code.png)\n```';
 await edit(body);await page.click('[data-feishu-save]');
 await page.waitForFunction(()=>document.querySelector('[data-feishu-save-status]').textContent.includes('已保存'));
 assert.equal(server.uploadCount,1);assert.equal(server.records[0].fields['图片'].length,1);assert.deepEqual(server.uploads.get(server.records[0].fields['图片'][0].file_token),server.imageBytes);
 const begin=async()=>{await page.click('[data-feishu-save]');await status('已有保存结果');await page.click('[data-feishu-duplicate]');};
 assert.equal(server.records[0].fields['正文'],body);assert.equal(server.records[0].fields['保存状态'],'已完成');
 server.fault='lost';await begin();await status('需要核对');const createRecords=server.records.length;await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,createRecords,'含图未知创建先找回再关联');
 await edit('![一](https://mmbiz.qpic.cn/partial-one.png)\n\n![二](https://mmbiz.qpic.cn/partial-two.png)');server.uploadRejectAt=server.uploadCount+2;await begin();await status('飞书拒绝');const partialUploads=server.uploadCount;server.images.set('https://mmbiz.qpic.cn/partial-one.png',false);await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.uploadCount,partialUploads+1,'部分成功回执核对复用，仅补剩余图片');await edit(body);
 server.imageFault='uploadReject';await begin();await status('飞书拒绝');assert.equal(server.records.at(-1).fields['保存状态'],'未完成');await page.click('[data-feishu-retry]');await status('已保存');
 server.imageFault='associateReject';await begin();await status('飞书拒绝');const uploads=server.uploadCount;assert.deepEqual(server.records.at(-1).fields['图片'],[]);await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.uploadCount,uploads,'已上传回执复用，不再次上传');
 server.imageFault='associateLost';await begin();await status('需要核对');const lostUploads=server.uploadCount,lostWrites=server.writes;server.hideAttachments=true;await page.click('[data-feishu-retry]');await status('图片关联结果待确认');assert.equal(server.writes,lostWrites);server.hideAttachments=false;await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.uploadCount,lostUploads);
 server.imageFault='uploadLost';await begin();await status('需要核对');const unknownUploads=server.uploadCount;await page.click('[data-feishu-retry]');await status('图片上传结果待确认');assert.equal(server.uploadCount,unknownUploads);assert.equal(server.records.at(-1).fields['保存状态'],'未完成');
 await page.evaluate(()=>chrome.storage.local.remove('feishuSave'));
 const writes=server.writes;
 for(const empty of ['![空图]()','![空图](<>)']){await edit(empty);await begin();await status('图片地址无效');assert.equal(server.writes,writes);assert((await page.$eval('[data-feishu-save-status]',el=>el.textContent)).includes('第 1 行'));}
 server.images.set('https://mmbiz.qpic.cn/missing.png',false);await edit('![缺图](https://mmbiz.qpic.cn/missing.png)');await begin();await status('图片无法下载');assert.equal(server.writes,writes);
 await edit('![域外](https://example.com/outside.png)');await begin();await status('图片无法下载');assert.equal(server.writes,writes);
 const huge=Buffer.alloc(20*1024*1024+1);server.imageBytes.copy(huge);server.images.set('https://mmbiz.qpic.cn/huge.png',huge);await edit('![过大](https://mmbiz.qpic.cn/huge.png)');await begin();await status('超过 20 MiB');assert.equal(server.writes,writes);
 server.images.set('https://mmbiz.qpic.cn/exact.png',huge.subarray(0,20*1024*1024));await edit('![上限](https://mmbiz.qpic.cn/exact.png)');await begin();await status('已保存');assert.equal(server.uploads.get(server.records.at(-1).fields['图片'][0].file_token).length,20*1024*1024);
 await edit(Array.from({length:100},(_,i)=>`![${i}](https://mmbiz.qpic.cn/many-${i}.png)`).join('\n'));await begin();await status('已保存');assert.equal(server.records.at(-1).fields['图片'].length,100);
 const stored=await page.evaluate(()=>chrome.storage.local.get('feishuSave'));assert(!JSON.stringify(stored).includes('base64'));assert(JSON.stringify(stored).length<100000,'计划只保存元数据，不缓存图片字节');
 console.log('✓ 图片预检零写入、20MiB边界、100附件、上传/关联拒绝补齐、未知回执保守暂停、记录与附件内容');
 console.log('✓ 含图保存去重上传、附件字节与完成状态');
}finally{await browser.close();}
