import { launchChrome } from './chrome.mjs';
import { feishuFixture } from './feishu-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const browser = await launchChrome({headless:true,enableExtensions:[path.resolve('dist')],args:['--no-sandbox']});
try {
 const worker = await (await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
 const page = await browser.newPage();page.setDefaultTimeout(5000);
 const server = feishuFixture();server.fields[6].property={options:[{name:'技术'},{name:'阅读'},{name:'科技'}]};
 await server.install(page);
 await page.goto(`chrome-extension://${await worker.evaluate(()=>chrome.runtime.id)}/app.html`);
 await page.waitForSelector('[data-view-mode="empty"]');await server.seed(page);
 await page.evaluate(()=>window.__wetrim.processCaptureResult({kind:'article',source:{title:'标签文章',account:'公众号',publishedAt:null,url:'https://mp.weixin.qq.com/s/tags'},contentHtml:'<p>标签测试正文</p>',unstable:false}));
 await page.waitForSelector('[data-feishu-save]');
 await page.click('[data-feishu-tags-open]');
 await page.waitForSelector('input[type="checkbox"][value="技术"]');
 await page.click('input[type="checkbox"][value="技术"]');
 await page.click('[data-feishu-tags-apply]');
 await page.click('[data-feishu-save]');
 await page.waitForFunction(()=>document.querySelector('[data-feishu-save-status]').textContent.includes('已保存'));
 assert.deepEqual(server.records[0].fields['标签'],['技术']);
 console.log('✓ 已有标签通过完整界面选择并随文章写入');
 const status = text => page.waitForFunction(text=>document.querySelector('[data-feishu-save-status]').textContent.includes(text)&&!document.querySelector('[data-feishu-save]').disabled,{},text);
 const type = async (selector,text) => {await page.click(selector);await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.type(selector,text);};
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-search]');
 await type('[data-feishu-tags-search]','阅');
 await page.waitForSelector('input[value="阅读"]');assert.equal(await page.$('input[value="技术"]'),null);
 await page.click('input[value="阅读"]');
 await type('[data-feishu-tags-new]','  新分类  ');await page.click('[data-feishu-tags-add]');
 await type('[data-feishu-tags-new]','新分类');await page.click('[data-feishu-tags-add]');
 await type('[data-feishu-tags-new]','   ');await page.click('[data-feishu-tags-add]');
 await type('[data-feishu-tags-new]','科技');await page.click('[data-feishu-tags-add]');
 await page.click('[data-feishu-tags-apply]');
 await page.click('[data-feishu-save]');await status('已有保存结果');await page.click('[data-feishu-duplicate]');await status('已保存');
 assert.deepEqual(server.records.at(-1).fields['标签'],['技术','阅读','新分类','科技']);
 console.log('✓ 搜索、多选、新输入；去首尾空格、空项、完全重复，保留近义标签');
 assert.deepEqual(server.fields[6].property.options.map(option=>option.name),['技术','阅读','科技','新分类'],'新标签随保存创建，旧选项保留');
 const writesBeforeCancel=server.writes;const optionsBeforeCancel=structuredClone(server.fields[6].property.options);
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-new]');
 await type('[data-feishu-tags-new]','取消的新标签');await page.click('[data-feishu-tags-add]');await page.click('[data-feishu-tags-cancel]');
 assert.equal(server.writes,writesBeforeCancel);assert.deepEqual(server.fields[6].property.options,optionsBeforeCancel);
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-new]');
 await page.click('[data-feishu-tags-clear]');await type('[data-feishu-tags-new]','取消保存的新标签');await page.click('[data-feishu-tags-apply]');
 await page.click('[data-feishu-save]');await status('已有保存结果');
 await page.click('.feishu-save-panel button::-p-text(取消)');await status('已取消');
 assert.equal(server.writes,writesBeforeCancel);assert.deepEqual(server.fields[6].property.options,optionsBeforeCancel);
 console.log('✓ 取消输入与取消保存都不创建标签或写远端');
 const selectOnly = async tag => {
  await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-new]');
  await page.click('[data-feishu-tags-clear]');if(tag)await type('[data-feishu-tags-new]',tag);
  await page.click('[data-feishu-tags-apply]');
 };
 const begin = async () => {await page.click('[data-feishu-save]');await status('已有保存结果');await page.click('[data-feishu-duplicate]');};
 await selectOnly(' 固定标签 ');server.fault='reject';await begin();await status('飞书拒绝');
 const fixed = await page.evaluate(async()=> (await chrome.storage.local.get('feishuSave')).feishuSave);
 assert.deepEqual(fixed.values.tags,['固定标签'],'真实 local 保存固定标签');
 await selectOnly('后续选择');await page.click('[data-feishu-retry]');await status('已保存');
 assert.deepEqual(server.records.at(-1).fields['标签'],['固定标签']);
 assert.equal(server.fields[6].property.options.some(option=>option.name==='后续选择'),false,'重试不能新建当前界面标签');
 // 确认另存期间再编辑，不应改变已提示那次保存的固定标签。
 await page.click('[data-feishu-save]');await status('已有保存结果');await selectOnly('确认期间变化');
 await page.click('[data-feishu-duplicate]');await status('已保存');assert.deepEqual(server.records.at(-1).fields['标签'],['后续选择']);
 console.log('✓ 标签固定在真实 local，失败重试与另存确认不混入后来选择');
 await selectOnly('');await begin();await status('已保存');assert.deepEqual(server.records.at(-1).fields['标签'],[]);
 server.fields[6].field_name='我的分类';await selectOnly('改名之后');await begin();await status('已保存');
 assert.deepEqual(server.records.at(-1).fields['我的分类'],['改名之后']);assert.equal(Object.hasOwn(server.records.at(-1).fields,'标签'),false);
 const beforeInvalid=server.writes;server.fields[6].type=1;
 await page.click('[data-feishu-tags-open]');await page.waitForFunction(()=>document.querySelector('.feishu-tags [role="alert"]')?.textContent.includes('类型不兼容'));
 assert.equal(await page.$eval('[data-feishu-tags-apply]',el=>el.disabled),true);await page.click('[data-feishu-tags-cancel]');
 await page.click('[data-feishu-save]');await status('类型不兼容');assert.equal(server.writes,beforeInvalid);
 server.fields[6].type=4;server.failFields=true;
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('.feishu-tags [role="alert"]');
 assert.equal(await page.$eval('[data-feishu-tags-apply]',el=>el.disabled),true);await page.click('[data-feishu-tags-cancel]');
 assert.equal(server.writes,beforeInvalid);server.failFields=false;await selectOnly('恢复读取');
 // 恢复日志落盘失败：没有文章写入，也没有标签副作用。
 await page.evaluate(()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async items=>{if(items.feishuSave)throw new Error('测试磁盘不可用');return set(items);};});
 await begin();await status('本机进度');assert.equal(server.writes,beforeInvalid);
 assert.equal(server.fields[6].property.options.some(option=>option.name==='恢复读取'),false);
 console.log('✓ 可空标签、按 ID 改名、类型/读取失败可修复、本地失败零标签写入');
 await page.click('[data-feishu-tags-open]');await page.waitForSelector('[data-feishu-tags-search]');
 const artifacts = path.resolve(process.env.WETRIM_ARTIFACTS || 'artifacts/pr', 'verify-issue62');
 await mkdir(artifacts,{recursive:true});
 await page.screenshot({path:path.join(artifacts,'tags-open.png'),fullPage:true});



} finally {await browser.close();}
