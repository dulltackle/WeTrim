import { useEffect, useRef, useState } from 'react';
import type { ArticleSnapshot } from '../../shared/types';
import { TagPicker } from './TagPicker';
import { abandonSave, saveAsNew, readSave, retrySave, startSave, type SavePlan, type SaveResult } from './save';

export function SavePanel({getSnapshot}: {getSnapshot: () => ArticleSnapshot | undefined}) {
 const [recovery,setRecovery]=useState<SavePlan|null>(null);
 const [confirm,setConfirm]=useState<'abandon'|'copy'|null>(null);
 const [tags,setTags]=useState<string[]>([]);
 const duplicateTags=useRef<string[]>([]);
 const [result,setResult]=useState<SaveResult>({message:''});const [busy,setBusy]=useState(false);
 const inFlight=useRef(false);const duplicateSnapshot=useRef<ArticleSnapshot | null>(null);
 useEffect(()=>{void readSave().then(plan=>{if(plan&&!plan.completed){setRecovery(plan);setResult({message:'有未完成的飞书保存，可核对并继续原次保存。',plan});}}).catch(()=>setResult({message:'本机飞书进度无法读取，已暂停。'}));},[]);
 async function run(mode:'new'|'duplicate'|'retry') {
  if(inFlight.current)return;inFlight.current=true;setBusy(true);
  try {
   const snapshot=mode==='duplicate'?duplicateSnapshot.current:getSnapshot();
   setResult({message:mode==='retry'?'正在核对原次保存…':'正在保存到飞书…'});
   const next=mode==='retry'?await retrySave():snapshot?await startSave(snapshot,mode==='duplicate',mode==='duplicate'?duplicateTags.current:tags):{message:'没有可保存的文章。'};
   duplicateSnapshot.current=next.duplicate&&snapshot?structuredClone(snapshot):null;
   if(next.duplicate)duplicateTags.current=[...tags];setResult(next);
   try{const saved=await readSave();setRecovery(saved&&!saved.completed?saved:null);}catch{/* 保留已知进度，不把读取失败当作没有。 */}
  } finally {inFlight.current=false;setBusy(false);}
 }
 async function finishRecovery(mode: 'abandon'|'copy') {
  if(inFlight.current||!recovery)return;inFlight.current=true;setBusy(true);
  try {const next=await (mode==='abandon'?abandonSave(recovery.group):saveAsNew(recovery.group));setResult(next);setConfirm(null);const saved=await readSave();setRecovery(saved&&!saved.completed?saved:null);}
  catch {setResult({message:'本机进度暂时无法读取，请重试。'});}
  finally {inFlight.current=false;setBusy(false);}
 }
 return <section className="feishu-save-panel" aria-label="飞书保存">
  <TagPicker value={tags} onChange={value=>setTags([...new Set(value.map(tag=>tag.trim()).filter(Boolean))])} disabled={busy}/>
  <div className="feishu-save-actions">
   <button className="action-btn action-preview" data-feishu-save disabled={busy} onClick={()=>void run('new')}>保存到飞书</button>
   <button className="action-btn action-preview" data-feishu-retry disabled={busy} onClick={()=>void run('retry')}>核对并继续原次保存</button>
  </div>
  <p role="status" data-feishu-save-status>{result.message}</p>
  {recovery&&<div className="feishu-recovery-actions">
   <p>恢复使用原次固定内容。已上传图片先核对，尚未上传的图片需要重新获取；图片源失效时保存会保持未完成。</p>
   <button className="action-btn action-preview" data-feishu-copy-recovery disabled={busy} onClick={()=>setConfirm('copy')}>另存原次完整内容</button>
   <button className="action-btn action-preview" data-feishu-abandon disabled={busy} onClick={()=>setConfirm('abandon')}>放弃这次保存</button>
   {confirm==='copy'&&<div data-feishu-recovery-confirm><p>使用原次固定内容另存完整一份，不含后续清洗编辑。原次远端结果和人工修改都会保留；本机恢复进度改为新的一次保存。</p><div className="feishu-save-actions"><button className="action-btn action-preview" data-feishu-copy-confirm disabled={busy} onClick={()=>void finishRecovery('copy')}>确认另存完整一份</button><button className="action-btn action-preview" disabled={busy} onClick={()=>setConfirm(null)}>取消</button></div></div>}
   {confirm==='abandon'&&<div data-feishu-recovery-confirm><p>仅清除本机恢复内容；清洗会话、连接和远端部分都会保留。远端记录及图片需要你到飞书自行查看、删除。</p><div className="feishu-save-actions"><button className="action-btn action-preview" data-feishu-abandon-confirm disabled={busy} onClick={()=>void finishRecovery('abandon')}>确认放弃本机进度</button><button className="action-btn action-preview" data-feishu-abandon-cancel disabled={busy} onClick={()=>setConfirm(null)}>取消</button></div></div>}
  </div>}
  {result.duplicate&&<div><button className="action-btn action-preview" data-feishu-duplicate disabled={busy} onClick={()=>void run('duplicate')}>保留旧结果，另存一份</button><button className="action-btn action-preview" onClick={()=>{duplicateSnapshot.current=null;setResult({message:'已取消，没有写入飞书。'});}}>取消</button></div>}
 </section>;
}
