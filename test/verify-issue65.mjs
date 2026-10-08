import { launchChrome } from './chrome.mjs';
import { feishuFixture } from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const browser = await launchChrome({headless:true,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
try {
 const worker = await (await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
 const page = await browser.newPage();page.setDefaultTimeout(5000);
 const server = feishuFixture();await server.install(page);
 await page.goto(`chrome-extension://${await worker.evaluate(()=>chrome.runtime.id)}/app.html`);
 await page.waitForSelector('[data-view-mode="empty"]');await server.seed(page);
 await page.click('[data-feishu-settings]');
 await page.waitForSelector('[data-feishu-test-start]');
 const copy=await page.$eval('[data-feishu-test]',el=>el.innerText);
 assert(copy.includes('示例正文')&&copy.includes('测试图片')&&copy.includes('远端')&&copy.includes('手动删除'));
 assert.equal(server.writes,0,'展开测试入口不写入');
 const status=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-test-status]').textContent.includes(text)&&!document.querySelector('[data-feishu-test-start]').disabled,{},text);
 await page.click('[data-feishu-test-start]');await status('正文与图片写入通过');
 assert.equal(server.records.length,1);
 assert(server.records[0].fields['正文'].includes('这是 WeTrim 的测试正文'));
 assert.equal(server.records[0].fields['保存状态'],'已完成');
 assert.equal(server.records[0].fields['图片'].length,1);
 const image=server.uploads.get(server.records[0].fields['图片'][0].file_token);
 const dimensions=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));const result=[bitmap.width,bitmap.height];bitmap.close();return result;},Array.from(image));
 assert.deepEqual(dimensions,[16,16],'实际上传图片可解码');
 assert((await page.$eval('[data-feishu-test-link]',el=>el.href)).includes('table=tblFixture'));
 const artifacts=path.resolve(process.env.WETRIM_ARTIFACTS||'artifacts/pr','verify-issue65');await mkdir(artifacts,{recursive:true});
 await page.screenshot({path:path.join(artifacts,'test-save.png'),fullPage:true});
 console.log('✓ 独立测试入口明确远端副作用，示例正文、可打开图片、关联与完成核对通过');
 const start=()=>page.click('[data-feishu-test-start]');
 const retry=()=>page.click('[data-feishu-test-retry]');
 const noPass=async()=>assert.equal(await page.$('[data-feishu-test-link]'),null,'失败不能显示通过入口');
 // 只读连接检查仍零写；测试内容和清洗文章完全隔离。
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'不能上传的用户标题',account:'用户账号',publishedAt:null,url:'https://mp.weixin.qq.com/s/private'},contentHtml:'<p>不能上传的用户正文</p>',unstable:false}));
 await page.waitForSelector('[data-feishu-save]');
 await page.type('#feishu-url','https://example.feishu.cn/base/appFixture?table=tblFixture');await page.type('#feishu-token','fixture-not-a-secret');
 const beforeCheck=server.writes;await page.click('[data-feishu-check]');
 await page.waitForFunction(()=>document.querySelector('[data-feishu-status]').textContent.includes('连接检查通过'));
 assert.equal(server.writes,beforeCheck);
 await start();await status('正文与图片写入通过');
 assert(!JSON.stringify(server.records.at(-1)).includes('不能上传'));
 assert((await page.$eval('[data-block-order="1"]',el=>el.innerText)).includes('不能上传的用户正文'));
 // 明确失败：正文、上传、关联和完成均可补齐原次，保留部分产物。
 for(const stage of ['create','upload','associate','complete']){
  const before=server.records.length;
  if(stage==='create')server.fault='reject';
  if(stage==='upload')server.imageFault='uploadReject';
  if(stage==='associate')server.imageFault='associateReject';
  if(stage==='complete')server.onWrite=async method=>{if(method==='PUT'&&server.records.at(-1).fields['保存状态']==='未完成'){server.onWrite=null;server.fault='reject';}};
  await start();await status('飞书拒绝');await noPass();
  assert.equal(server.records.length,before+(stage==='create'?0:1));
  if(stage!=='create')assert.equal(server.records.at(-1).fields['保存状态'],'未完成');
  await retry();await status('正文与图片写入通过');assert.equal(server.records.length,before+1);
  assert.equal(server.records.at(-1).fields['图片'].length,1);assert.equal(server.records.at(-1).fields['保存状态'],'已完成');
 }
 // 请求成功但回执丢失：记录查无一次不重建，关联和完成仅核对。
 server.fault='lost';const beforeLost=server.records.length;await start();await status('需要核对');await noPass();
 server.hide=true;const lostWrites=server.writes;await retry();await status('保存结果待确认');assert.equal(server.writes,lostWrites);
 server.hide=false;await retry();await status('正文与图片写入通过');assert.equal(server.records.length,beforeLost+1);
 server.imageFault='associateLost';await start();await status('需要核对');await noPass();
 server.hideAttachments=true;const associationWrites=server.writes;await retry();await status('图片关联结果待确认');assert.equal(server.writes,associationWrites);
 server.hideAttachments=false;await retry();await status('正文与图片写入通过');
 // onWrite 是网络边界注入：仅在完成请求已生效时丢掉响应。
 server.onWrite=async method=>{if(method==='PUT'&&server.records.at(-1).fields['保存状态']==='已完成'){server.onWrite=null;server.fault='lost';}};
 await start();await status('需要核对');await noPass();const completedWrites=server.writes;
 await retry();await status('正文与图片写入通过');assert.equal(server.writes,completedWrites);
 server.imageFault='uploadLost';await start();await status('需要核对');await noPass();
 const unknownUploads=server.uploadCount;const unknownRecords=server.records.length;
 await retry();await status('图片上传结果待确认');assert.equal(server.uploadCount,unknownUploads);assert.equal(server.records.length,unknownRecords);assert.equal(server.records.at(-1).fields['保存状态'],'未完成');
 console.log('✓ 正文/上传/关联/完成明确失败与未知回执、核对重试、不删除部分产物');
 // 场景隔离只删测试恢复内容，不调用产品内部函数；放弃由恢复票联验。
 await page.evaluate(()=>chrome.storage.local.remove('feishuSave'));
 // 普通文章即使写入同一个固定图片地址，也必须经过原权限校验。
 await page.click('[data-block-order="1"] [data-testid="block-action-edit"]');
 await page.$eval('[data-block-order="1"] textarea',el=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'![试图绕过](https://wetrim.invalid/test-image.png)');el.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.click('[data-block-order="1"] [data-testid="block-action-finish-edit"]');
 const beforeBypass=server.writes;await page.click('[data-feishu-save]');
 await page.waitForFunction(()=>document.querySelector('[data-feishu-save-status]').textContent.includes('图片无法下载或地址不受支持'));
 assert.equal(server.writes,beforeBypass);
 // 写前恢复存储失败仍为零远端写入。
 await page.evaluate(()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async items=>{if(items.feishuSave)throw new Error('测试存储不可用');return set(items);};});
 await start();await status('本机进度');assert.equal(server.writes,beforeBypass);await noPass();
 console.log('✓ 用户内容隔离、只读检查零写、普通文章不能绕过图片权限、本地失败零远端写入');
} finally {await browser.close();}
