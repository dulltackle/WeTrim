import { useEffect, useRef, useState } from 'react';
import { TestSavePanel } from './TestSavePanel';
import { readGeneration, GENERATION_KEY, CONNECTION_KEY, PendingTargetError, clearConnection, checkConnection, ConnectionError, FEISHU_ORIGIN, FIELD_SCHEMA, parseTarget, readConnection, saveConnection, type CheckedConnection, type FeishuConnection } from './connection';

export function ConnectionSettings() {
 const [url, setUrl] = useState(''); const [token, setToken] = useState('');
 const [saved, setSaved] = useState<FeishuConnection | null>(null);
 const [checked, setChecked] = useState<CheckedConnection | null>(null);
 const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
 const operation = useRef(0);
 const checkedGeneration=useRef('initial');
 const [switching,setSwitching]=useState(false);
 const [clearing,setClearing]=useState(false);
 async function clear(){operation.current++;setChecked(null);try{await clearConnection();setSaved(null);setUrl('');setToken('');setClearing(false);setStatus('已清除本机连接与恢复内容。清洗会话和远端数据均保留。');}catch{setStatus('本机连接未能清除，请重试。');}finally{setBusy(false);}}
 useEffect(() => {
  let live = true;const initial=operation.current;
  void readConnection().then(value => { if (live && operation.current===initial && value) { setSaved(value); setUrl(value.url); setToken(value.token); setStatus(`已连接：${value.baseName} / ${value.tableName}。保存前将重新检查字段。`); } }).catch(() => { if (live) setStatus('无法读取本机连接，请重试。'); });
  const revoked = () => { operation.current++; setChecked(null); setBusy(false); setStatus('浏览器飞书权限发生变化，请重新检查连接；清洗文章不受影响。'); };
  const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area!=='local'||(!changes[CONNECTION_KEY]&&!changes[GENERATION_KEY]))return;const version=++operation.current;setChecked(null);setSwitching(false);setBusy(false);void readConnection().then(value=>{if(!live||version!==operation.current)return;setSaved(value);setUrl(value?.url??'');setToken(value?.token??'');});};
  chrome.storage.onChanged.addListener(changed);
  chrome.permissions.onRemoved.addListener(revoked);
  return () => { live = false; operation.current++; chrome.permissions.onRemoved.removeListener(revoked);chrome.storage.onChanged.removeListener(changed); };
 }, []);
 function invalidate() { operation.current++; setChecked(null); setStatus(''); }
 async function check(remap = false) {
  if (busy) return;
  const current = ++operation.current; setChecked(null); setBusy(true);
  try {
   const target = parseTarget(url);
   if (!token.trim()) throw new ConnectionError('请填写目标表格的个人授权码。');
   // 紧接用户点击申请，不能先等待网络或存储而丢失 user gesture。
   const allowed = await chrome.permissions.request({ origins: [FEISHU_ORIGIN] });
   if (!allowed) throw new ConnectionError('浏览器未允许访问飞书。可再次点击检查连接申请；清洗文章不受影响。');
   const generation=await readGeneration();
   const result = await checkConnection(target, token, remap ? null : saved);
   if (current === operation.current && generation===await readGeneration()) { checkedGeneration.current=generation;setChecked(result); setStatus('连接检查通过：仅检查目标和字段，尚未写入任何记录。请确认目标。'); }
  } catch (error) { if (current === operation.current) setStatus(error instanceof ConnectionError ? error.message : '连接检查未完成，请重试。'); }
  finally { if (current === operation.current) setBusy(false); }
 }
 async function confirm(abandon=false) {
  if (!checked || busy) return;
  setBusy(true);
  try { await saveConnection(checked.connection,abandon,checkedGeneration.current);setSwitching(false); setSaved(checked.connection); setChecked(null); setStatus('连接已保存到当前浏览器。未写入飞书记录。'); }
  catch(error) { if(error instanceof PendingTargetError)setSwitching(true);setStatus(error instanceof ConnectionError?error.message:'连接未能保存到当前浏览器，请重试。'); }
  finally { setBusy(false); }
 }
 return <details className="feishu-settings">
  <summary data-feishu-settings>飞书连接</summary>
  <div className="feishu-settings-content">
   <h2>连接你的多维表格</h2>
   <p><a href="https://dulltackle.feishu.cn/base/SKQdbFpCOaipFws5nercV1wwnMe?table=tblrP4IsRN8d2ctW" target="_blank" rel="noreferrer">打开十二列文章收藏模板</a>，从模板菜单选择「创建副本 / Make a Copy」，复制到自己的空间并选择「仅复制结构」。检查副本的访问权限，再从副本的数据表复制链接。</p>
   <p>请填写你自己的副本链接和个人授权码，不要向公共母模板保存。授权码可在副本 Base 的扩展工具中获取，仅保存在当前浏览器，不同步。</p>
   <form onSubmit={event => { event.preventDefault(); void check(); }}>
    <label htmlFor="feishu-url">目标表格链接</label>
    <input id="feishu-url" type="url" required value={url} disabled={busy} onChange={event => { invalidate(); setUrl(event.target.value); }} placeholder="https://你的空间.feishu.cn/base/…?table=…" />
    <label htmlFor="feishu-token">个人授权码</label>
    <input id="feishu-token" type="password" required autoComplete="off" value={token} disabled={busy} onChange={event => { invalidate(); setToken(event.target.value); }} />
    <button type="submit" data-feishu-check disabled={busy}>{busy ? '正在检查…' : '检查连接'}</button>
   </form>
   {saved && <div><p>如果删除后重新创建了字段，普通检查会暂停。请先恢复十二列的标准名称和类型，再重新识别并确认映射；确认前仍保留原配置。</p><button type="button" data-feishu-remap disabled={busy} onClick={() => void check(true)}>按标准列名重新检查映射</button></div>}
   <p role="status" data-feishu-status>{status}</p>
   {checked && <div>
    <h3>确认目标：{checked.connection.baseName} / {checked.connection.tableName}</h3>
    <a href={checked.connection.url} target="_blank" rel="noreferrer">打开目标表格</a>
    <ul>{FIELD_SCHEMA.map(([key, name]) => <li key={key}>{name} → {checked.fields[key].field_name}（检查通过）</li>)}</ul>
    <button data-feishu-confirm disabled={busy} onClick={() => void confirm()}>确认连接此表格</button>
   </div>}
   {switching && <div data-feishu-maintenance><p>原目标还有未完成保存。取消换表后可继续旧保存；确认放弃只清本机恢复内容，保留清洗会话及旧目标远端部分。新目标将创建新的保存记录。</p><button type="button" data-feishu-maintenance-cancel onClick={()=>setSwitching(false)}>取消换表，继续旧保存</button><button type="button" data-feishu-switch-confirm disabled={busy} onClick={()=>void confirm(true)}>放弃旧恢复并连接新目标</button></div>}
   <button type="button" data-feishu-clear onClick={()=>setClearing(true)}>清除本机连接</button>
   {clearing && <div data-feishu-maintenance><p>确认删除本机授权码、目标配置和保存恢复内容？清洗会话和远端数据均保留。</p><button type="button" data-feishu-maintenance-cancel onClick={()=>setClearing(false)}>取消</button><button type="button" data-feishu-clear-confirm onClick={()=>void clear()}>确认清除本机连接</button></div>}
   <p data-feishu-revoke-guide>本机清除不会撤销飞书授权。请回到飞书目标 Base 获取个人授权码的扩展工具中撤销或重置授权码；远端记录和附件需在飞书自行管理。</p>
   <TestSavePanel />
  </div>
 </details>;
}
