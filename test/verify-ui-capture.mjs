/** 用同一 fixture 捕获各迁移票的前后界面，并核对 CSP、页面错误和横向溢出。 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const option=(name)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const ticket=Number(option('--ticket')),scenario=option('--scenario');
if(!Number.isInteger(ticket)||ticket<71||ticket>77)throw new Error('请通过 --ticket 指定 #71–#77');
const checkout=process.cwd(),baseline=option('--baseline');
const target=baseline?path.resolve(baseline):checkout;
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim();
const evidence={ticket,scenario:Number(scenario)||null,dirty:!baseline && execFileSync('git',['status','--porcelain'],{cwd:checkout,encoding:'utf8'}).trim().length>0,phase:baseline?'迁移前':'迁移后',commit:baseline?(option('--baseline-ref')||'外部基线，请结合调用方记录核对版本'):commit,buildFiles:fs.readdirSync(path.join(target,'dist/assets')).filter(f=>/\.(css|js)$/.test(f))};
const output=path.resolve(process.env.WETRIM_ARTIFACTS||'artifacts/ui-migration',`${evidence.phase==='迁移前'?'before':'after'}-${ticket}-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
let source=fs.readFileSync(path.join(checkout,scenario ? `test/verify-issue${Number(scenario)}.mjs` : `scripts/capture-issue${ticket}.mjs`),'utf8')
 .replace(/import\s*{\s*launchChrome\s*}/, 'import { launchChrome as captureLauncher }')
 .replaceAll("'../test/",`'${checkout}/test/`)
 .replace(`path.resolve('artifacts/issue${ticket}')`,JSON.stringify(output));
if (scenario) {
 if (![58,64,65].includes(Number(scenario))) throw new Error('状态截图只支持 #58/#64/#65 的现有替身场景');
 source=source.replaceAll("from './", `from '${checkout}/test/`);
 source=source.replace(/const status\s*=\s*text\s*=>\s*page\.waitForFunction/, 'const waitStatus = text => page.waitForFunction');
 const statusEnd=source.indexOf('\n',source.indexOf('const waitStatus'));
 if(statusEnd<0)throw new Error('状态观察入口未找到');
 source=source.slice(0,statusEnd)+`
 let stateShot=0;
 const status=async text=>{await waitStatus(text);const old=page.viewport();for(const width of [1200,360]){await page.setViewport({width,height:900});await page.screenshot({path:${JSON.stringify(output)}+'/'+String(++stateShot).padStart(3,'0')+'-'+width+'.png',fullPage:true});}await page.setViewport(old);};
 `+source.slice(statusEnd);
}
const prefix=`
import {writeFileSync as captureWrite} from 'node:fs';
const captureEvidence=${JSON.stringify({...evidence,output})};
async function launchChrome(options){
 const browser=await captureLauncher(options),create=browser.newPage.bind(browser);
 browser.newPage=async(...args)=>{
  const page=await create(...args),errors=[];
  let busyCaptured=false;
  page.on('request',request=>{
    if (!captureEvidence.scenario || busyCaptured || request.method()!=='GET' || !request.url().startsWith('https://base-api.feishu.cn/')) return;
    busyCaptured=true;
    const respond=request.respond.bind(request);
    request.respond=async options=>{
      await page.waitForFunction(()=>[...document.querySelectorAll('[data-feishu-check],[data-feishu-test-start],[data-feishu-save]')].some(e=>e.disabled));
      const old=page.viewport();
      for(const width of [1200,360]){await page.setViewport({width,height:900});await page.screenshot({path:captureEvidence.output+'/busy-'+width+'.png',fullPage:true});}
      await page.setViewport(old);
      return respond(options);
    };
  });

  page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(()=>{window.__captureCsp=[];document.addEventListener('securitypolicyviolation',e=>window.__captureCsp.push({directive:e.violatedDirective,blocked:e.blockedURI}));});
  const shot=page.screenshot.bind(page);
  page.screenshot=async options=>{
   await page.evaluate(async()=>{
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));
   });
   const state=await page.evaluate(()=>({csp:window.__captureCsp||[],width:innerWidth,scrollWidth:document.documentElement.scrollWidth,status:[...document.querySelectorAll('[role=status]')].map(e=>e.textContent),focus:document.activeElement?.getAttribute('data-testid')||document.activeElement?.id||document.activeElement?.tagName}));
   const result=await shot(options);captureWrite(options.path+'.json',JSON.stringify({...captureEvidence,state,errors},null,2));
   if(state.csp.length||errors.length||state.scrollWidth>state.width)throw new Error('截图场景存在 CSP、页面错误或横向溢出，见截图旁的 JSON');
   return result;
  };
  return page;
 };
 return browser;
}
`;
source=source.replaceAll("'"+checkout, "'file://"+checkout);
process.chdir(target);
console.log(`本次证据目录：${output}`);
const modulePath=path.join(output,'capture-source.mjs');
fs.writeFileSync(modulePath,prefix+source);
await import(pathToFileURL(modulePath).href);
