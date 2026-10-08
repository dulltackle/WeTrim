import { useEffect, useRef, useState } from 'react';
import type { ArticleSnapshot } from '../../shared/types';
import { TagPicker } from './TagPicker';
import { readSave, retrySave, startSave, type SaveResult } from './save';

export function SavePanel({getSnapshot}: {getSnapshot: () => ArticleSnapshot | undefined}) {
 const [tags,setTags]=useState<string[]>([]);
 const duplicateTags=useRef<string[]>([]);
 const [result,setResult]=useState<SaveResult>({message:''});const [busy,setBusy]=useState(false);
 const inFlight=useRef(false);const duplicateSnapshot=useRef<ArticleSnapshot | null>(null);
 useEffect(()=>{void readSave().then(plan=>{if(plan&&!plan.completed)setResult({message:'有未完成的飞书保存，可核对并继续原次保存。',plan});}).catch(()=>setResult({message:'本机飞书进度无法读取，已暂停。'}));},[]);
 async function run(mode:'new'|'duplicate'|'retry') {
  if(inFlight.current)return;inFlight.current=true;setBusy(true);
  try {
   const snapshot=mode==='duplicate'?duplicateSnapshot.current:getSnapshot();
   setResult({message:mode==='retry'?'正在核对原次保存…':'正在保存到飞书…'});
   const next=mode==='retry'?await retrySave():snapshot?await startSave(snapshot,mode==='duplicate',mode==='duplicate'?duplicateTags.current:tags):{message:'没有可保存的文章。'};
   duplicateSnapshot.current=next.duplicate&&snapshot?structuredClone(snapshot):null;
   if(next.duplicate)duplicateTags.current=[...tags];setResult(next);
  } finally {inFlight.current=false;setBusy(false);}
 }
 return <section className="feishu-save-panel" aria-label="飞书保存">
  <TagPicker value={tags} onChange={value=>setTags([...new Set(value.map(tag=>tag.trim()).filter(Boolean))])} disabled={busy}/>
  <div className="feishu-save-actions">
   <button className="action-btn action-preview" data-feishu-save disabled={busy} onClick={()=>void run('new')}>保存到飞书</button>
   <button className="action-btn action-preview" data-feishu-retry disabled={busy} onClick={()=>void run('retry')}>核对并继续原次保存</button>
  </div>
  <p role="status" data-feishu-save-status>{result.message}</p>
  {result.duplicate&&<div><button className="action-btn action-preview" data-feishu-duplicate disabled={busy} onClick={()=>void run('duplicate')}>保留旧结果，另存一份</button><button className="action-btn action-preview" onClick={()=>{duplicateSnapshot.current=null;setResult({message:'已取消，没有写入飞书。'});}}>取消</button></div>}
 </section>;
}
