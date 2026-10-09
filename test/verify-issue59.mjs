import { launchChrome } from './chrome.mjs';
import { feishuFixture } from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser=await launchChrome({headless:true,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
try {
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
 const page=await browser.newPage();page.setDefaultTimeout(5000);
 const server=feishuFixture();await server.install(page);
 await page.goto(`chrome-extension://${await worker.evaluate(()=>chrome.runtime.id)}/app.html`);
 await page.waitForSelector('[data-view-mode="empty"]');await server.seed(page);
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'文章标题',account:'公众号',publishedAt:'2026-10-01',url:'https://mp.weixin.qq.com/s/example?scene=1'},contentHtml:'<p>第一段</p><p>第二段</p>',unstable:false}));
 await page.waitForSelector('[data-feishu-save]');const firstSaveStarted=Date.now();await page.click('[data-feishu-save]');
 await page.waitForFunction(()=>document.querySelector('[data-feishu-save-status]').textContent.includes('已保存'));
 assert.equal(server.records.length,1);assert.equal(server.records[0].fields['正文'],'第一段\n\n第二段');assert.equal(server.records[0].fields['保存状态'],'已完成');
 assert.equal(server.records[0].fields['标题'],'文章标题');assert.equal(server.records[0].fields['公众号名称'],'公众号');assert.equal(server.records[0].fields['原文发布日期'],Date.parse('2026-10-01T00:00:00+08:00'));assert.equal(server.records[0].fields['分篇序号'],1);assert.equal(server.records[0].fields['分篇总数'],1);
 assert.deepEqual(server.records[0].fields['原文链接'],{text:'https://mp.weixin.qq.com/s/example?scene=1',link:'https://mp.weixin.qq.com/s/example?scene=1'});assert(server.records[0].fields['保存时间']>=firstSaveStarted&&server.records[0].fields['保存时间']<=Date.now());
 const status = text => page.waitForFunction(text=>document.querySelector('[data-feishu-save-status]').textContent.includes(text)&&!document.querySelector('[data-feishu-save]').disabled,{},text);
 const begin = async()=>{await page.click('[data-feishu-save]');await status('已有保存结果');await page.click('[data-feishu-duplicate]');};
 const original=structuredClone(server.records[0]);
 await begin();await status('已保存');assert.equal(server.records.length,2);assert.deepEqual(server.records[0],original);assert.notEqual(server.records[0].fields['文章关联标识'],server.records[1].fields['文章关联标识']);
 server.fault='reject';await begin();await status('飞书拒绝');assert.equal(server.records.length,2);
 await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,3);
 server.fault='lost';await begin();await status('需要核对');assert.equal(server.records.length,4);
 server.hide=true;const count=server.writes;await page.click('[data-feishu-retry]');await status('保存结果待确认');assert.equal(server.writes,count);assert.equal(server.records.length,4);
 server.hide=false;await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,4);
 await page.evaluate(()=>{
  const get=chrome.storage.local.get.bind(chrome.storage.local),set=chrome.storage.local.set.bind(chrome.storage.local);let armed=true,fail=false;
  chrome.storage.local.set=async items=>{await set(items);if(armed&&items.feishuSave?.pending==='create'){armed=false;fail=true;}};
  chrome.storage.local.get=async keys=>{if(fail&&keys==='feishuConnection'){fail=false;throw new Error('写前目标读取暂时失败');}return get(keys);};
 });
 const beforeGuardFail=server.writes;await begin();await status('本机进度');assert.equal(server.writes,beforeGuardFail,'写前资格检查失败没有请求');
 await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,5,'未发送意图清除后可补齐');
 server.fault='malformed';await begin();await status('飞书');const malformedCount=server.records.length;await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,malformedCount,'无业务码响应不能当作明确失败重建');
 server.fault='completeLost';await begin();await status('需要核对');assert.equal(server.records.length,7);
 const completedWrites=server.writes;await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.writes,completedWrites,'完成回执未知时回读即可完成，不重发');
 server.fault='lost';await begin();await status('需要核对');server.records.at(-1).fields['正文']='人工修改';const conflictWrites=server.writes;
 await page.click('[data-feishu-retry]');await status('已暂停');assert.equal(server.writes,conflictWrites);assert.equal(server.records.at(-1).fields['正文'],'人工修改');
 const deleted=server.records.pop();await page.click('[data-feishu-retry]');await status('保存结果待确认');assert.equal(server.writes,conflictWrites);server.records.push(deleted);
 // 隔离下一个场景，清除的只是测试进度；真实使用的放弃流程由后续维护票负责。
 await page.evaluate(()=>chrome.storage.local.remove('feishuSave'));
 await page.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async items=>{if(items.feishuSave)throw new Error('测试存储失败');return original(items);};});
 const beforeLocalFail=server.writes;await begin();await status('本机进度');assert.equal(server.writes,beforeLocalFail);
 await page.reload();await page.waitForSelector('[data-feishu-save]');await server.seed(page);
 server.onWrite=async method=>{if(method==='POST'){server.onWrite=null;await page.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);let once=true;chrome.storage.local.set=async items=>{if(items.feishuSave&&once){once=false;throw new Error('测试回执落盘失败');}return original(items);};});}};
 const receiptCount=server.records.length;await begin();await status('本机进度');assert.equal(server.records.length,receiptCount+1);
 await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.length,receiptCount+1);
 server.fault='reject';await begin();await status('飞书拒绝');
 await page.click('[data-block-order="1"] [data-testid="block-action-edit"]');
 const editor='[data-block-order="1"] textarea';await page.focus(editor);await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.type(editor,'后续编辑');
 await page.click('[data-block-order="1"] [data-testid="block-action-finish-edit"]');
 await page.click('[data-feishu-retry]');await status('已保存');assert.equal(server.records.at(-1).fields['正文'],'第一段\n\n第二段','重试保留固定正文');
 await page.click('[data-feishu-save]');await status('已有保存结果');
 const beforeDouble=server.records.length;
 await page.evaluate(()=>{const button=document.querySelector('[data-feishu-duplicate]');button.click();button.click();});await status('已保存');assert.equal(server.records.at(-1).fields['正文'],'后续编辑\n\n第二段');assert.equal(server.records.length-beforeDouble,1,'连续点击只创建一份');assert.equal(new Set(server.records.slice(beforeDouble).map(record=>record.fields['文章关联标识'])).size,1);
 const second=await browser.newPage();await second.goto(page.url());await second.waitForSelector('[data-testid="read-only-switch-writer"]');assert.equal(await second.$('[data-feishu-save]'),null,'第二页面无写入口');await second.close();
 const editFirst=async value=>{await page.click('[data-block-order="1"] [data-testid="block-action-edit"]');await page.$eval('[data-block-order="1"] textarea',(el,value)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);await page.click('[data-block-order="1"] [data-testid="block-action-finish-edit"]');};
 await page.click('[data-block-order="2"] [data-testid="block-action-exclude"]');
 await editFirst('');const boundaryWrites=server.writes;await page.click('[data-feishu-save]');await status('清洗结果为空');assert.equal(server.writes,boundaryWrites);
 await editFirst('"'.repeat(45000));await begin();await status('已保存');assert.equal(server.records.at(-1).fields['正文'],'"'.repeat(45000));
 // 只经抓取结果边界换文章，再从候选确认界面替换，不操作保存内部函数。
 const replaceArticle=async(source,contentHtml='<p>同一正文</p>')=>{
  await page.evaluate(({source,contentHtml})=>window.__wetrim.processCaptureResult({kind:'article',source,contentHtml,unstable:false}),{source,contentHtml});
  await page.waitForSelector('[data-testid="candidate-btn-replace"]');await page.click('[data-testid="candidate-btn-replace"]');
  await page.waitForFunction(()=>!document.querySelector('.candidate-confirm-dialog[open]'));await page.waitForSelector('[data-feishu-save]');
 };
 const sameTitle={title:'文章标题',account:'公众号',publishedAt:'2026-10-01'};
 const prior=structuredClone(server.records);const beforeTracking=server.writes;
 await replaceArticle({...sameTitle,url:'https://mp.weixin.qq.com/s/example?scene=9&from=timeline&isappinstalled=0&share_token=tracking&clicktime=123&enterid=456#rd'});
 await page.click('[data-feishu-save]');await status('已有保存结果');assert.equal(server.writes,beforeTracking,'追踪参数变化仍提示同源且未写');assert.deepEqual(server.records,prior);
 // 从重复确认区域取消，不创建新组。
 await page.evaluate(()=>{const confirm=document.querySelector('[data-feishu-duplicate]').parentElement;[...confirm.querySelectorAll('button')].find(button=>button.textContent==='取消').click();});await status('已取消');assert.equal(server.writes,beforeTracking);
 const beforeDifferent=server.records.length;
 for(const url of ['https://mp.weixin.qq.com/s/example?scene=1&mid=business-A','https://mp.weixin.qq.com/s/example?scene=1&mid=business-B','https://mp.weixin.qq.com/s/different-article']){
  const timestamp=Date.now();await replaceArticle({...sameTitle,url});await page.click('[data-feishu-save]');await status('已保存');
  assert.deepEqual(server.records.at(-1).fields['原文链接'],{text:url,link:url});assert(server.records.at(-1).fields['保存时间']>=timestamp&&server.records.at(-1).fields['保存时间']<=Date.now());
 }
 assert.equal(server.records.length-beforeDifferent,3,'业务参数或路径不同即使同标题同正文也不合并');assert.equal(new Set(server.records.slice(beforeDifferent).map(record=>record.fields['文章关联标识'])).size,3);assert.deepEqual(server.records.slice(0,prior.length),prior);
 await replaceArticle({title:'',account:null,publishedAt:null,url:'https://mp.weixin.qq.com/s/missing-source'});
 await page.click('[data-feishu-save]');await status('已保存');assert.equal(server.records.at(-1).fields['标题'],'');assert.equal(server.records.at(-1).fields['公众号名称'],'');assert.equal(server.records.at(-1).fields['原文发布日期'],undefined);
 await replaceArticle({title:'无法解析日期',account:null,publishedAt:'不是可靠日期',url:'https://mp.weixin.qq.com/s/invalid-date'});
 await page.click('[data-feishu-save]');await status('已保存');assert.equal(server.records.at(-1).fields['公众号名称'],'');assert.equal(server.records.at(-1).fields['原文发布日期'],undefined);
 await replaceArticle({...sameTitle,url:'https://mp.weixin.qq.com/s/conversion-note'},'<table><tbody><tr><td rowspan="2">合并单元格</td><td>甲</td></tr><tr><td>乙</td></tr></tbody></table>');
 const note='表格包含合并单元格或复杂嵌套，已降级为可读文本';await page.waitForFunction(note=>[...document.querySelectorAll('[data-testid="block-notes"], [data-testid="block-notes-sr"]')].some(el=>el.textContent.includes(note)),{},note);
 await page.click('[data-feishu-save]');await status('已保存');const savedBody=server.records.at(-1).fields['正文'];assert.match(savedBody,/合并单元格/);assert.match(savedBody,/甲/);assert.match(savedBody,/乙/);assert.equal(savedBody.includes(note),false,'真实转换提示不进入正文');assert.equal(savedBody.startsWith('---\n'),false,'不插入本地导出的front matter');
 console.log('✓ 同源追踪参数变化提示且取消零写；业务参数/路径不同不按标题正文合并；来源空值/不可解析日期与实际URL/保存时间；转换提示排除；连续点击仅一组');
 console.log('✓ #59阶段边界：空白与剔除零写入，JSON转义90000预算；后续图片/分篇票应更新阶段断言');
 console.log('✓ 回执落盘失败先找回、重试内容固定、当前编辑另存、连续点击、多页面写入资格');
 console.log('✓ 普通、重复另存、明确拒绝后继续、创建/完成回执丢失、暂不可见不重建、人工修改保护、写前本地失败零远端写入');
} finally {await browser.close();}
