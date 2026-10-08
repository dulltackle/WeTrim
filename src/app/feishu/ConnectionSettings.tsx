import { useEffect, useRef, useState } from 'react';
import { checkConnection, ConnectionError, FEISHU_ORIGIN, FIELD_SCHEMA, parseTarget, readConnection, saveConnection, type CheckedConnection, type FeishuConnection } from './connection';

export function ConnectionSettings() {
 const [url, setUrl] = useState(''); const [token, setToken] = useState('');
 const [saved, setSaved] = useState<FeishuConnection | null>(null);
 const [checked, setChecked] = useState<CheckedConnection | null>(null);
 const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
 const operation = useRef(0);
 useEffect(() => {
  let live = true;
  void readConnection().then(value => { if (live && value) { setSaved(value); setUrl(value.url); setToken(value.token); setStatus(`已连接：${value.baseName} / ${value.tableName}。保存前将重新检查字段。`); } }).catch(() => { if (live) setStatus('无法读取本机连接，请重试。'); });
  const revoked = () => { operation.current++; setChecked(null); setBusy(false); setStatus('浏览器飞书权限发生变化，请重新检查连接；清洗文章不受影响。'); };
  chrome.permissions.onRemoved.addListener(revoked);
  return () => { live = false; operation.current++; chrome.permissions.onRemoved.removeListener(revoked); };
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
   const result = await checkConnection(target, token, remap ? null : saved);
   if (current === operation.current) { setChecked(result); setStatus('连接检查通过：仅检查目标和字段，尚未写入任何记录。请确认目标。'); }
  } catch (error) { if (current === operation.current) setStatus(error instanceof ConnectionError ? error.message : '连接检查未完成，请重试。'); }
  finally { if (current === operation.current) setBusy(false); }
 }
 async function confirm() {
  if (!checked || busy) return;
  setBusy(true);
  try { await saveConnection(checked.connection); setSaved(checked.connection); setChecked(null); setStatus('连接已保存到当前浏览器。未写入飞书记录。'); }
  catch { setStatus('连接未能保存到当前浏览器，请重试。'); }
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
  </div>
 </details>;
}
