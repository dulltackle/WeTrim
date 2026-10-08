import { useId, useRef, useState } from 'react';
import { checkConnection, ConnectionError, readConnection } from './connection';

/** 标签选择只读取选项；只有正式保存才把选定标签提交给飞书。 */
export function TagPicker({ value, onChange, disabled }: { value: string[]; onChange: (tags: string[]) => void; disabled: boolean }) {
 const id = useId();
 const opener = useRef<HTMLButtonElement>(null);
 const generation = useRef(0);
 const [open, setOpen] = useState(false);
 const [options, setOptions] = useState<string[]>([]);
 const [draft, setDraft] = useState<string[]>([]);
 const [search, setSearch] = useState('');
 const [newTag, setNewTag] = useState('');
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 async function edit() {
  const current = ++generation.current;
  setOpen(true); setDraft([...value]); setSearch(''); setNewTag(''); setLoading(true); setError('');
  try {
   const connection = await readConnection();
   if (!connection) throw new ConnectionError('请先检查并确认飞书连接，再选择标签。');
   const checked = await checkConnection(connection, connection.token, connection);
   const available = checked.fields.tags.property?.options ?? [];
   if (!Array.isArray(available) || available.some(option => typeof option?.name !== 'string')) throw new ConnectionError('标签选项无法读取，请检查标签字段后重新选择。');
   if (current === generation.current) setOptions([...new Set(available.map(option => option.name.trim()).filter(Boolean))]);
  } catch (cause) {
   if (current === generation.current) setError(cause instanceof ConnectionError ? cause.message : '标签读取失败，请检查连接后重新选择。');
  } finally { if (current === generation.current) setLoading(false); }
 }
 function close() { ++generation.current; setOpen(false); setLoading(false); opener.current?.focus(); }
 function add() { const tag = newTag.trim(); if (tag) setDraft(previous => [...new Set([...previous, tag])]); setNewTag(''); }
 return <div className="feishu-tags">
  <button ref={opener} type="button" className="action-btn action-preview" data-feishu-tags-open disabled={disabled} aria-expanded={open} aria-controls={id} onClick={()=>void edit()}>选择标签（可选）</button>
  <span>{value.length ? `已选：${value.join('、')}` : '未选择标签'}</span>
  {open && <fieldset id={id} disabled={disabled}>
   <legend>文章标签</legend>
   <p id={`${id}-help`}>可以不选。新标签只随实际保存提交；保存开始后，新建的标签不会自动撤回。</p>
   {loading && <p role="status">正在读取已有标签…</p>}
   {error ? <p role="alert">{error}</p> : !loading && <>
    <label className="feishu-tag-field" htmlFor={`${id}-search`}>搜索已有标签<input id={`${id}-search`} name="tag-search" type="search" data-feishu-tags-search value={search} onChange={event=>setSearch(event.target.value)} /></label>
    <div className="feishu-tag-options">{options.filter(tag=>tag.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(tag => <label key={tag}><input type="checkbox" name="article-tag" value={tag} checked={draft.includes(tag)} onChange={event=>setDraft(event.target.checked ? [...draft, tag] : draft.filter(item=>item!==tag))}/>{tag}</label>)}</div>
    {!options.some(tag=>tag.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p>没有匹配的已有标签，可以输入新标签。</p>}
    <label className="feishu-tag-field" htmlFor={`${id}-new`}>输入新标签<input id={`${id}-new`} name="new-tag" data-feishu-tags-new value={newTag} aria-describedby={`${id}-help`} onChange={event=>setNewTag(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();add();}}}/></label>
    <button type="button" className="action-btn action-preview" data-feishu-tags-add onClick={add}>添加标签</button>
    <p>本次选择：{draft.length ? draft.join('、') : '不选标签'}</p>
    <button type="button" className="action-btn action-preview" data-feishu-tags-clear onClick={()=>{setDraft([]);setNewTag('');}}>清空选择</button>
   </>}
   <div className="feishu-save-actions"><button type="button" className="action-btn action-preview" data-feishu-tags-apply disabled={!!error || loading} onClick={()=>{onChange([...draft, newTag]);close();}}>使用这些标签</button><button type="button" className="action-btn action-preview" data-feishu-tags-cancel onClick={close}>取消选择</button></div>
  </fieldset>}
 </div>;
}
