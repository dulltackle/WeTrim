import {launchChrome} from './chrome.mjs';
import {feishuFixture} from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser=await launchChrome({headless:true,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
try{
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();const page=await browser.newPage();page.setDefaultTimeout(6000);const server=feishuFixture();await server.install(page);
 await page.goto(`chrome-extension://${await worker.evaluate(()=>chrome.runtime.id)}/app.html`);await page.waitForSelector('[data-view-mode]');await server.seed(page);
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'维护保留文章',account:'测试',publishedAt:'2026-10-08',url:'https://mp.weixin.qq.com/s/maintenance'},contentHtml:'<p>保留清洗正文</p>',unstable:false}));await page.waitForSelector('[data-feishu-save]');
 const local=()=>page.evaluate(()=>chrome.storage.local.get(null));
 const status=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-status]')?.textContent.includes(text),{},text);
 const saved=text=>page.waitForFunction(text=>document.querySelector('[data-feishu-save-status]')?.textContent.includes(text)&&!document.querySelector('[data-feishu-retry]').disabled,{},text);
 server.fault='lost';await page.click('[data-feishu-save]');await saved('需要核对');await page.waitForSelector('[data-save-status="saved"]');
 const before=await local(),remote=structuredClone(server.records);
 await page.click('[data-feishu-settings]');await page.click('[data-feishu-clear]');await page.waitForSelector('[data-feishu-clear-confirm]');
 assert.match(await page.$eval('[data-feishu-maintenance]',el=>el.textContent),/授权码.*目标.*恢复/);
 await page.click('[data-feishu-maintenance-cancel]');assert.deepEqual(await local(),before);assert.deepEqual(server.records,remote);
 await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');
 const cleared=await local();assert.equal(cleared.feishuConnection,undefined);assert.equal(cleared.feishuSave,undefined);assert.deepEqual(cleared.currentSession,before.currentSession);assert.deepEqual(server.records,remote);
 assert.match(await page.$eval('[data-feishu-revoke-guide]',el=>el.textContent),/飞书.*撤销/);
 console.log('✓ 清除需确认，取消零改变；仅清连接与恢复，清洗和远端保持原状，说明飞书撤销');

 const input=async(selector,value)=>{await page.$eval(selector,(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);};
 const check=async(target='tblFixture',code='fixture-new-code')=>{await input('#feishu-url',`https://example.feishu.cn/base/appFixture?table=${target}`);await input('#feishu-token',code);await page.click('[data-feishu-check]');await status('连接检查通过');};
 await check();await page.click('[data-feishu-confirm]');await status('连接已保存');
 server.fault='lost';await page.click('[data-feishu-save]');await saved('已有保存结果');await page.click('[data-feishu-duplicate]');await saved('需要核对');
 const pending=(await local()).feishuSave;
 server.authStatus=401;await input('#feishu-token','bad-fixture-code');await page.click('[data-feishu-check]');await status('飞书鉴权失败');assert.equal((await local()).feishuConnection.token,'fixture-new-code');assert.deepEqual((await local()).feishuSave,pending);
 server.authStatus=null;await check('tblFixture','fixture-rotated');await page.click('[data-feishu-confirm]');await status('连接已保存');assert.deepEqual((await local()).feishuSave,pending);
 server.failRecords=true;const count=server.writes;await page.click('[data-feishu-retry]');await saved('飞书拒绝');assert.equal(server.writes,count);server.failRecords=false;
 await page.click('[data-feishu-retry]');await saved('已保存');assert.equal(server.records.filter(r=>r.fields['文章关联标识']===pending.group).length,1);
 server.fault='lost';await page.click('[data-feishu-save]');await saved('已有保存结果');await page.click('[data-feishu-duplicate]');await saved('需要核对');
 const oldTarget=await local();server.tableIds=['tblFixture','tblSecond'];await check('tblSecond');await page.click('[data-feishu-confirm]');
 await page.waitForSelector('[data-feishu-switch-confirm]');assert.deepEqual((await local()).feishuSave,oldTarget.feishuSave);assert.deepEqual((await local()).feishuConnection,oldTarget.feishuConnection);
 await page.click('[data-feishu-maintenance-cancel]');assert.deepEqual((await local()).feishuConnection,oldTarget.feishuConnection);
 await page.click('[data-feishu-confirm]');await page.waitForSelector('[data-feishu-switch-confirm]');await page.click('[data-feishu-switch-confirm]');await status('连接已保存');assert.equal((await local()).feishuSave,undefined);assert.equal((await local()).feishuConnection.tableId,'tblSecond');
 assert.deepEqual((await local()).currentSession,before.currentSession);
 console.log('✓ 同目标换码保留计划并先核对；鉴权/不可读不推断不存在；换表须明确放弃，取消零改变');


 let release,entered;const gate=new Promise(resolve=>release=resolve);const started=new Promise(resolve=>entered=resolve);
 server.onWrite=async()=>{server.onWrite=null;entered();await gate;};
 const staleCount=server.records.length;await page.click('[data-feishu-save]');await started;assert.notEqual((await local()).feishuSave.group,oldTarget.feishuSave.group);assert.equal((await local()).feishuSave.target.tableId,'tblSecond');
 await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');
 await check('tblSecond','fixture-after-clear');await page.click('[data-feishu-confirm]');await status('连接已保存');
 release();await page.waitForFunction(()=>!document.querySelector('[data-feishu-retry]').disabled);
 assert.equal((await local()).feishuSave,undefined,'旧回执不能复活被清除的恢复内容');assert.equal((await local()).feishuConnection.token,'fixture-after-clear');
 assert.equal(server.records.length,staleCount+1);assert.equal(server.records.at(-1).fields['保存状态'],'未完成','已经写入的远端部分保留且无后续完成写入');
 assert.deepEqual((await local()).currentSession,before.currentSession);
 console.log('✓ 保存回执迟到且同目标重连，旧操作不能复活恢复记录或继续写入');


 // 检查请求迟到：清除本机后不能重新显示旧确认卡。
 let releaseCheck,enterCheck;const checkGate=new Promise(r=>releaseCheck=r),checkStarted=new Promise(r=>enterCheck=r);
 server.onRequest=async()=>{server.onRequest=null;enterCheck();await checkGate;};
 await page.click('[data-feishu-check]');await checkStarted;await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');releaseCheck();
 await page.waitForFunction(()=>!document.querySelector('[data-feishu-check]').disabled);
 await page.waitForNetworkIdle({idleTime:100});assert.equal(await page.$('[data-feishu-confirm]'),null);assert.equal((await local()).feishuConnection,undefined);
 // 浏览器拒绝/撤销与飞书鉴权分开说明，不改清洗。
 await input('#feishu-url','https://example.feishu.cn/base/appFixture?table=tblSecond');await input('#feishu-token','permission-fixture');
 await page.evaluate(()=>{chrome.permissions.request=async()=>false;chrome.permissions.contains=async()=>false;});await page.click('[data-feishu-check]');await status('浏览器未允许');
 await page.evaluate(()=>{chrome.permissions.request=async()=>true;chrome.permissions.contains=async()=>true;});await check('tblSecond');await page.click('[data-feishu-confirm]');await status('连接已保存');
 await page.evaluate(()=>{chrome.permissions.contains=async()=>false;});await page.click('[data-feishu-save]');await saved('浏览器尚未允许');await page.evaluate(()=>{chrome.permissions.contains=async()=>true;});
 assert.deepEqual((await local()).currentSession,before.currentSession);
 // 在途本地 set 在配置锁内完成，清除随后移除，不会被延迟回写复活。
 await page.evaluate(()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);window.__releaseLocal=null;window.__localHeld=false;chrome.storage.local.set=async items=>{if(items.feishuSave&&!window.__localHeld){window.__localHeld=true;await new Promise(r=>window.__releaseLocal=r);}return set(items);};});
 await page.click('[data-feishu-save]');await saved('已有保存结果');await page.click('[data-feishu-duplicate]');await page.waitForFunction(()=>window.__localHeld);
 await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await page.evaluate(()=>window.__releaseLocal());await status('已清除');await page.waitForFunction(()=>!document.querySelector('[data-feishu-retry]').disabled);
 assert.equal((await local()).feishuSave,undefined);assert.equal((await local()).feishuConnection,undefined);
 assert.equal(await page.$eval('#feishu-token',el=>el.value),'');
 console.log('✓ 迟到连接检查、本地落盘与清除串行；浏览器拒绝/撤销单独反馈，清洗不变');


 await check('tblSecond');await page.click('[data-feishu-confirm]');await status('连接已保存');const sharedBefore=await local();
 
 const reader=await browser.newPage();reader.setDefaultTimeout(6000);await server.install(reader);await reader.goto(page.url());await reader.bringToFront();await server.seed(reader,false);await reader.waitForSelector('[data-feishu-settings]');await reader.click('[data-feishu-settings]');
 await reader.waitForFunction(()=>document.querySelector('#feishu-token').value.length>0);await reader.click('[data-feishu-check]');await reader.waitForSelector('[data-feishu-confirm]');await reader.click('[data-feishu-confirm]');
 await reader.waitForFunction(()=>document.querySelector('[data-feishu-status]').textContent.includes('未能保存'),{polling:50});assert.deepEqual(await local(),sharedBefore);
 await reader.click('[data-feishu-clear]');await reader.click('[data-feishu-clear-confirm]');await reader.waitForFunction(()=>document.querySelector('[data-feishu-status]').textContent.includes('未能清除'));assert.deepEqual(await local(),sharedBefore);
 await page.bringToFront();await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');
 await reader.bringToFront();await reader.waitForFunction(()=>document.querySelector('#feishu-token').value==='');assert.equal(await reader.$('[data-feishu-confirm]'),null);await reader.close();
 assert.deepEqual((await local()).currentSession,before.currentSession);assert.equal((await page.$eval('[data-feishu-status]',el=>el.textContent)).includes('fixture-'),false);
 console.log('✓ 只读页面维护无写入资格；跨页面清除即时丢弃旧确认与授权码显示');


 await check('tblSecond');await page.click('[data-feishu-confirm]');await status('连接已保存');server.fault='lost';
 await page.click('[data-feishu-save]');await saved('已有保存结果');await page.click('[data-feishu-duplicate]');await saved('需要核对');
 let releaseRecovery,enterRecovery;const recoveryGate=new Promise(r=>releaseRecovery=r),recoveryStarted=new Promise(r=>enterRecovery=r);
 server.onRequest=async request=>{if(!request.url().includes('/records'))return;server.onRequest=null;enterRecovery();await recoveryGate;};
 await page.click('[data-feishu-retry]');await recoveryStarted;const recoveryRemote=structuredClone(server.records),recoveryWrites=server.writes;
 await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await status('已清除');await check('tblSecond');await page.click('[data-feishu-confirm]');await status('连接已保存');releaseRecovery();
 await page.waitForFunction(()=>!document.querySelector('[data-feishu-retry]').disabled);assert.equal((await local()).feishuSave,undefined);assert.equal(server.writes,recoveryWrites);assert.deepEqual(server.records,recoveryRemote);
 await check('tblSecond','fixture-delayed-confirm');
 await page.evaluate(()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);window.__confirmHeld=false;chrome.storage.local.set=async items=>{if(items.feishuConnection&&!window.__confirmHeld){window.__confirmHeld=true;await new Promise(r=>window.__releaseConfirm=r);}return set(items);};});
 await page.click('[data-feishu-confirm]');await page.waitForFunction(()=>window.__confirmHeld);await page.click('[data-feishu-clear]');await page.click('[data-feishu-clear-confirm]');await page.evaluate(()=>window.__releaseConfirm());await status('已清除');
 assert.equal((await local()).feishuConnection,undefined);assert.equal((await local()).feishuSave,undefined);assert.equal(await page.$eval('#feishu-token',el=>el.value),'');assert.deepEqual((await local()).currentSession,before.currentSession);
 console.log('✓ 迟到恢复读取不继续写；连接确认本地落盘与清除串行，旧配置不复活');


 await check('tblSecond');await page.click('[data-feishu-confirm]');await status('连接已保存');
 let releaseSwitch,enterSwitch;const switchGate=new Promise(r=>releaseSwitch=r),switchStarted=new Promise(r=>enterSwitch=r);
 server.onWrite=async()=>{server.onWrite=null;enterSwitch();await switchGate;};await page.click('[data-feishu-save]');await saved('已有保存结果');await page.click('[data-feishu-duplicate]');await switchStarted;
 const failedSwitchWrites=server.writes;const preservedSwitchPlan=(await local()).feishuSave;await check('tblFixture');await page.click('[data-feishu-confirm]');await page.waitForSelector('[data-feishu-switch-confirm]');
 await page.evaluate(()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async items=>{if(items.feishuConnection)throw new Error('测试配置写盘失败');return set(items);};});
 await page.click('[data-feishu-switch-confirm]');await status('未能保存');releaseSwitch();await page.waitForFunction(()=>!document.querySelector('[data-feishu-retry]').disabled);
 assert.equal(server.writes,failedSwitchWrites,'已确认放弃后即使新配置落盘失败，旧在途操作也不能继续');assert.equal((await local()).feishuConnection.tableId,'tblSecond');assert.deepEqual((await local()).feishuSave,preservedSwitchPlan);assert.equal(server.records.at(-1).fields['保存状态'],'未完成');assert.deepEqual((await local()).currentSession,before.currentSession);
 console.log('✓ 新目标配置写盘失败保守报错，已放弃的旧在途操作不继续写入');

}finally{await browser.close();}
