import { useRef, useState } from 'react';
import { readSave, retrySave, startTestSave, type SaveResult } from './save';

export function TestSavePanel() {
 const [result,setResult]=useState<SaveResult>({message:''});
 const [busy,setBusy]=useState(false);const inFlight=useRef(false);
 async function run(retry:boolean) {
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setResult({message:'正在测试保存并核对正文与图片…'});
  try {
   if(retry && !(await readSave())?.testSample){setResult({message:'没有待恢复的测试保存。文章保存请使用文章的恢复入口。'});return;}
   setResult(await (retry?retrySave():startTestSave()));
  } catch {setResult({message:'本机测试进度无法读取，已暂停，请重试核对。'});}
  finally {inFlight.current=false;setBusy(false);}
 }
 const passed=result.plan?.testSample&&result.plan.completed;
 return <section data-feishu-test aria-label="测试保存">
  <h3>测试正文与图片保存</h3>
  <p>此操作会向已确认的目标表写入一条远端测试记录：固定示例正文和一张无用户内容的蓝色测试图片。不使用你的文章内容。测试记录和图片需在飞书中手动删除；失败时也会保留已写入的部分。</p>
  <div className="feishu-save-actions">
   <button type="button" data-feishu-test-start disabled={busy} onClick={()=>void run(false)}>写入示例正文和测试图片</button>
   <button type="button" data-feishu-test-retry disabled={busy} onClick={()=>void run(true)}>核对并继续测试保存</button>
  </div>
  <p role="status" data-feishu-test-status>{passed?'正文与图片写入通过。请打开目标表查看，测试产物需手动删除。':result.message}</p>
  {passed&&<a data-feishu-test-link href={result.plan!.target.url} target="_blank" rel="noreferrer">打开目标表查看测试记录</a>}
 </section>;
}
