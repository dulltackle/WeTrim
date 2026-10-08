import { analyzeMarkdownImages } from '../export/markdown-image-refs';
import { planParts } from './parts';
import type { ArticleSnapshot } from '../../shared/types';
import { buildMarkdown, parseFrontMatterDate } from '../export/build-markdown';
import { prepareImages, sourceBytes, uploadImage, verifyUploadedImage, type PlannedImage, type ImageCache } from './images';
import { withWriterAccess, writerStorage } from '../state/writer-access';
import { TEST_BODY, TEST_IMAGE_URL, testSnapshot } from './test-sample';
import { checkConnection, ConnectionError, feishuRequest, FeishuRequestError, readConnection, type FeishuConnection, type CheckedConnection, FIELD_SCHEMA, type FieldKey } from './connection';

export const SAVE_KEY = 'feishuSave';
export type Values = Partial<Record<FieldKey, unknown>>;
export interface SavePlan {
 version: 1; group: string; target: Pick<FeishuConnection, 'appToken' | 'tableId' | 'fieldIds' | 'url'>;
 values: Values; recordId?: string; pending: 'create' | 'associate' | 'complete' | null; completed: boolean;
 parts?: SavePlan[];
 images?: PlannedImage[]; pendingUpload?: number | null; imagesAssociated?: boolean;
 testSample?: true;
}
export interface SaveResult { message: string; duplicate?: boolean; plan?: SavePlan; }
interface RemoteRecord { record_id: string; fields: Record<string, unknown> }

function validatePlan(value:SavePlan):void {
 if (!value || value.version !== 1 || typeof value.group !== 'string' || !value.target?.appToken || !value.target.tableId || !value.target.fieldIds || !value.values || value.values.group !== value.group || !['create', 'associate', 'complete', null].includes(value.pending) || typeof value.completed !== 'boolean' || FIELD_SCHEMA.some(([key]) => typeof value.target.fieldIds[key] !== 'string') || typeof value.values.body !== 'string' || typeof value.values.title !== 'string' || typeof value.values.account !== 'string' || !Number.isFinite(value.values.savedAt) || !Number.isInteger(value.values.part) || !Number.isInteger(value.values.total) || Number(value.values.part)<1 || Number(value.values.total)<Number(value.values.part) || JSON.stringify(value.values.body).length-2>90000 || value.values.status !== '未完成' || (value.recordId !== undefined && typeof value.recordId !== 'string') || (value.completed && !value.recordId)) throw new ConnectionError('本机飞书保存进度无法识别，已暂停。请保留数据并检查连接。');
 if (value.images && (!Array.isArray(value.images) || value.images.length > 100 || value.images.some(image => !image || typeof image.url !== 'string' || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) || (image.fileToken !== undefined && typeof image.fileToken !== 'string') || typeof image.fileName !== 'string' || !Number.isInteger(image.size) || image.size < 1 || image.size > 20 * 1024 * 1024))) throw new ConnectionError('本机图片保存计划无法识别，已暂停。');
 if ((value.pendingUpload !== undefined && value.pendingUpload !== null && (!Number.isInteger(value.pendingUpload) || value.pendingUpload < 0 || value.pendingUpload >= (value.images?.length ?? 0))) || (value.imagesAssociated !== undefined && typeof value.imagesAssociated !== 'boolean')) throw new ConnectionError('本机图片操作进度无法识别，已暂停。');
 if (value.testSample !== undefined && (value.testSample !== true || value.values.body !== TEST_BODY || value.images?.length !== 1 || value.images[0].url !== TEST_IMAGE_URL || value.values.total !== 1)) throw new ConnectionError('本机测试保存样例无法识别，已暂停。');
}
export async function readSave(): Promise<SavePlan | null> {
 const value=(await chrome.storage.local.get(SAVE_KEY))[SAVE_KEY] as SavePlan|undefined;if(value===undefined)return null;
 validatePlan(value);
 if(value.parts!==undefined&&!Array.isArray(value.parts))throw new ConnectionError('本机分篇计划无法识别，已暂停。');
 const all=allParts(value);
 for(let index=0;index<all.length;index++){
  const part=all[index];validatePlan(part);
  if(part.values.part!==index+1||part.values.total!==all.length||part.group!==value.group||(index>0&&(part.parts!==undefined||part.completed))||!sameTarget(part.target,{...value.target} as FeishuConnection)||['account','url','publishedAt','savedAt','tags'].some(key=>JSON.stringify(part.values[key as FieldKey])!==JSON.stringify(value.values[key as FieldKey])))throw new ConnectionError('本机分篇关联不一致，已暂停。');
 }
 const fullBody=all.map(part=>part.values.body).join('');
 const source=typeof value.values.url==='object'&&value.values.url?(value.values.url as {link?:string}).link:undefined;
 const analysis=analyzeMarkdownImages(fullBody,source);let offset=0;const assets=new Map<string,PlannedImage>();
 for(const part of all){
  const end=offset+String(part.values.body).length;
  const usages=analysis.usages.filter(usage=>usage.start>=offset&&usage.start<end);
  const expected=[...new Set(usages.map(usage=>usage.resolvedUrl))].sort();
  const images=part.images??[];
  if(usages.some(usage=>!usage.resolvedUrl||!usage.canRewrite||usage.end>end)||JSON.stringify(expected)!==JSON.stringify(images.map(image=>image.url).sort()))throw new ConnectionError('本机分篇图片对应关系不一致，已暂停。');
  for(const image of images){const previous=assets.get(image.url);if(previous&&(previous.sha256!==image.sha256||previous.size!==image.size))throw new ConnectionError('本机跨篇图片对应关系不一致，已暂停。');assets.set(image.url,image);}
  offset=end;
 }
 return value;
}
function allParts(plan:SavePlan):SavePlan[]{return [plan,...(plan.parts??[])];}
const persist = (plan: SavePlan, rootPlan:SavePlan=plan) => writerStorage.set({ [SAVE_KEY]: rootPlan });
function sameTarget(a: SavePlan['target'], b: FeishuConnection) { return a.appToken === b.appToken && a.tableId === b.tableId && Object.entries(a.fieldIds).every(([key,id]) => b.fieldIds[key as FieldKey] === id); }
async function activeConnection(plan?: SavePlan): Promise<CheckedConnection> {
 const connection = await readConnection();
 if (!connection) throw new ConnectionError('请先打开飞书连接，检查并确认目标表格。');
 if (plan && !sameTarget(plan.target, connection)) throw new ConnectionError('连接目标或字段映射已变化，原次保存已暂停。');
 return checkConnection(connection, connection.token, connection);
}
async function assertWriterAndTarget(plan: SavePlan) {
 await withWriterAccess(async () => {
  const current = await readConnection();
  if (!current || !sameTarget(plan.target, current)) throw new ConnectionError('连接已变化，保存已暂停。');
 });
}
function root(connection: FeishuConnection) { return `/bitable/v1/apps/${connection.appToken}/tables/${connection.tableId}/records`; }
async function records(connection: FeishuConnection): Promise<RemoteRecord[]> {
 const all: RemoteRecord[] = []; let token = ''; const seen = new Set<string>();
 do {
  const result = await feishuRequest<{items: RemoteRecord[]; has_more: boolean; page_token?: string}>(connection, `${root(connection)}?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
  if (!Array.isArray(result.items) || result.items.some(item => !item.record_id || !item.fields)) throw new ConnectionError('飞书记录列表不完整，已暂停核对。');
  all.push(...result.items);
  if (!result.has_more) return all;
  if (!result.page_token || seen.has(result.page_token)) throw new ConnectionError('飞书记录分页不完整，已暂停核对。');
  token = result.page_token; seen.add(token);
 } while (true);
}
function canonicalSource(input: string): string {
 try { const url = new URL(input); for (const key of ['scene','from','isappinstalled','share_token','clicktime','enterid']) url.searchParams.delete(key); url.hash=''; return url.href; } catch { return input; }
}
function normalize(value: unknown, key: FieldKey): unknown {
 if (value === undefined || value === null) return key === 'tags' || key === 'images' ? [] : '';
 if (key === 'part' || key === 'total' || key === 'savedAt' || key === 'publishedAt') return value === '' ? '' : Number(value);
 if (key === 'url') return typeof value === 'object' && !Array.isArray(value) ? (value as {link?: string}).link ?? '' : value;
 if (Array.isArray(value) && key !== 'tags' && key !== 'images') return value.map(part => typeof part === 'object' && part ? part.text ?? '' : part).join('');
 return value;
}
function readValue(record: RemoteRecord, checked: CheckedConnection, key: FieldKey) { return normalize(record.fields[checked.fields[key].field_name], key); }
function verify(record: RemoteRecord, checked: CheckedConnection, plan: SavePlan): '未完成' | '已完成' {
 for (const key of Object.keys(plan.values) as FieldKey[]) {
  if (key === 'status' || key === 'images') continue;
  if (JSON.stringify(readValue(record, checked, key)) !== JSON.stringify(normalize(plan.values[key], key))) throw new ConnectionError('远端内容已被修改或不一致，已暂停，不会覆盖。');
 }
 const status = readValue(record, checked, 'status');
 if (plan.completed && status !== '已完成') throw new ConnectionError('远端完成状态已被修改，已暂停，不会覆盖。');
 if (status !== '未完成' && !(status === '已完成' && (plan.pending === 'complete' || plan.completed))) throw new ConnectionError('远端保存状态已变化，已暂停，不会覆盖。');
 return status;
}
function payload(values: Values, checked: CheckedConnection) { return { fields: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null).map(([key,value]) => [checked.fields[key as FieldKey].field_name,value])) }; }
async function mutation(plan: SavePlan, checked: CheckedConnection, kind: 'create' | 'associate' | 'complete', rootPlan:SavePlan=plan) {
 plan.pending = kind;
 await persist(plan,rootPlan); // 写前意图必须落盘，失败绝不发请求。
 try { await assertWriterAndTarget(plan); }
 catch (error) {
  // 请求尚未发出，可以清理意图；清理也失败时磁盘保留原意图，继续保守暂停。
  plan.pending = null;
  try { await persist(plan,rootPlan); } catch { /* 不把未落盘的清理当作成功。 */ }
  throw error;
 }
 let response: {record: RemoteRecord};
 try {
  response = await feishuRequest(checked.connection, kind === 'create' ? root(checked.connection) : `${root(checked.connection)}/${plan.recordId}`, {
   method: kind === 'create' ? 'POST' : 'PUT', headers: {'Content-Type':'application/json'},
   body: JSON.stringify(payload(kind === 'create' ? plan.values : kind === 'associate' ? {images: imageAttachments(plan)} : { status:'已完成' },checked)),
  });
 } catch (error) {
  if (error instanceof ConnectionError && !(error instanceof FeishuRequestError && error.uncertain)) { plan.pending = null; await persist(plan,rootPlan); }
  throw error;
 }
 if (!response?.record?.record_id) throw new FeishuRequestError('飞书未返回可核对的记录回执，保存结果待确认。',true);
 if (kind === 'create') plan.recordId = response.record.record_id;
 // pending 保留到回读成功；回执落盘失败时下次仍按旧意图查找。
 await persist(plan,rootPlan);
}
function imageAttachments(plan:SavePlan) { return (plan.images??[]).map(image=>({file_token:image.fileToken})); }
function remoteTokens(record:RemoteRecord,checked:CheckedConnection):string[] {
 const value=readValue(record,checked,'images');
 if(!Array.isArray(value)||value.some(item=>!item||typeof item.file_token!=='string'))throw new ConnectionError('远端图片附件无法识别，已暂停。');
 return value.map(item=>item.file_token);
}
async function verifyImageAssociation(plan:SavePlan,checked:CheckedConnection,record:RemoteRecord){
 const expected=(plan.images??[]).map(image=>image.fileToken);
 const actual=remoteTokens(record,checked);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new ConnectionError('远端图片附件已变化或尚未完整关联，已暂停，不会覆盖。');
 for(const image of plan.images??[])await verifyUploadedImage(checked.connection,image,record.record_id);
}
async function settleImages(plan:SavePlan,checked:CheckedConnection,record:RemoteRecord,cache:ImageCache,rootPlan:SavePlan=plan){
 const images=plan.images??[];
 if(plan.imagesAssociated||plan.completed){await verifyImageAssociation(plan,checked,record);return;}
 const actual=remoteTokens(record,checked);
 if(plan.pending==='associate'){
  if(JSON.stringify(actual)!==JSON.stringify(images.map(image=>image.fileToken)))throw new ConnectionError('图片关联结果待确认，请稍后核对，不会重复关联。');
  await verifyImageAssociation(plan,checked,record);plan.imagesAssociated=true;plan.pending=null;await persist(plan,rootPlan);return;
 }
 if(actual.length)throw new ConnectionError('远端图片附件已被修改，已暂停，不会覆盖。');
 if(!images.length)return;
 if(plan.pendingUpload!==null&&plan.pendingUpload!==undefined)throw new ConnectionError(`图片上传结果待确认：${images[plan.pendingUpload]?.url??'原次图片'}。缺少可核对回执，不会重复上传。`);
 for(let index=0;index<images.length;index++){
  const image=images[index];
  const owner=allParts(rootPlan).find(part=>part.images?.some(candidate=>candidate.url===image.url&&candidate.fileToken));
  const receipt=owner?.images?.find(candidate=>candidate.url===image.url&&candidate.fileToken);
  if(receipt){await verifyUploadedImage(checked.connection,receipt,owner?.imagesAssociated?owner.recordId:undefined);image.fileToken=receipt.fileToken;await persist(plan,rootPlan);continue;}
  const fetched=await sourceBytes(image,cache,plan.testSample);
  plan.pendingUpload=index;await persist(plan,rootPlan);
  try{await assertWriterAndTarget(plan);}catch(error){plan.pendingUpload=null;try{await persist(plan,rootPlan);}catch{}throw error;}
  try{image.fileToken=await uploadImage(checked.connection,image,fetched.bytes);}catch(error){if(error instanceof ConnectionError&&!(error instanceof FeishuRequestError&&error.uncertain)){plan.pendingUpload=null;await persist(plan,rootPlan);}throw error;}
  plan.pendingUpload=null;await persist(plan,rootPlan);
 }
 await mutation(plan,checked,'associate',rootPlan);
 const current=(await records(checked.connection)).find(item=>item.record_id===record.record_id);
 if(!current)throw new ConnectionError('图片关联结果待确认，记录暂不可读取。');
 verify(current,checked,plan);await verifyImageAssociation(plan,checked,current);
 plan.imagesAssociated=true;plan.pending=null;await persist(plan,rootPlan);
}
async function drivePart(plan:SavePlan,rootPlan:SavePlan,checked:CheckedConnection,cache:ImageCache):Promise<void>{
 if(!plan.recordId&&!plan.pending)await mutation(plan,checked,'create',rootPlan);
 const matches=(await records(checked.connection)).filter(record=>plan.recordId?record.record_id===plan.recordId:readValue(record,checked,'group')===plan.group&&readValue(record,checked,'part')===plan.values.part);
 if(matches.length!==1)throw new ConnectionError(matches.length?'原次保存存在多条候选，保存结果待确认，已暂停。':'保存结果待确认：原次分篇已删除或暂不可见，不会重复创建，请稍后核对。');
 const record=matches[0];verify(record,checked,plan);plan.recordId=record.record_id;
 await settleImages(plan,checked,record,cache,rootPlan);
 if(plan.pending==='create')plan.pending=null;
 await persist(plan,rootPlan);
}
async function verifyAll(rootPlan:SavePlan,checked:CheckedConnection,requireComplete=false){
 const current=await records(checked.connection);
 for(const plan of allParts(rootPlan)){
  const record=current.find(item=>item.record_id===plan.recordId);
  if(!record)throw new ConnectionError('保存结果待确认：分篇已删除或暂不可见，不会重建。');
  const status=verify(record,checked,plan);await verifyImageAssociation(plan,checked,record);
  if(requireComplete&&plan===rootPlan&&status!=='已完成')throw new ConnectionError('保存结果待确认：首篇完成状态尚未确认。');
 }
}
async function drive(plan:SavePlan,cache:ImageCache=new Map()):Promise<SaveResult>{
 const checked=await activeConnection(plan);
 for(const part of allParts(plan))await drivePart(part,plan,checked,cache);
 await verifyAll(plan,checked);
 if(plan.pending==='complete'){
  await verifyAll(plan,checked,true);
 }else if(!plan.completed){
  await mutation(plan,checked,'complete');await verifyAll(plan,checked,true);
 }
 plan.pending=null;plan.completed=true;await persist(plan);
 return {message:`已保存到飞书，共 ${allParts(plan).length} 篇，正文、来源与图片核对通过。`,plan};
}
async function exclusive(operation: () => Promise<SaveResult>): Promise<SaveResult> {
 return navigator.locks.request('wetrim-feishu-save', {ifAvailable:true}, async lock => {
  if (!lock) return {message:'另一个保存操作正在进行，请稍候。'};
  try { await withWriterAccess(async()=>undefined);return await operation(); }
  catch (error) { return {message: error instanceof ConnectionError ? error.message : '本机进度或写入资格检查失败，已暂停；请重试核对原次保存。'}; }
 });
}
export function retrySave(): Promise<SaveResult> { return exclusive(async()=>{const plan=await readSave();if(!plan) return {message:'没有待继续的保存。'};return drive(plan);}); }
export function startSave(snapshot: ArticleSnapshot, allowDuplicate=false, tags: string[]=[]): Promise<SaveResult> {
 return startFixedSave(snapshot,allowDuplicate,tags,false);
}
export function startTestSave(): Promise<SaveResult> {
 return startFixedSave(testSnapshot(),true,[],true);
}
function startFixedSave(snapshot: ArticleSnapshot, allowDuplicate:boolean, tags:string[], testSample:boolean): Promise<SaveResult> {
 // 固定输入在首个 await 前，后续编辑不改变本次内容。
 const fixedTags = [...new Set(tags.map(tag=>tag.trim()).filter(Boolean))];
 const body = buildMarkdown(snapshot.blocks); const source = structuredClone(snapshot.source);
 return exclusive(async()=>{
  const existing=await readSave();if(existing && !existing.completed) return {message:'有未完成的保存，请先核对并继续原次保存。',plan:existing};
  if (!body.trim()) return {message:'清洗结果为空，没有写入飞书。'};
  const checked=await activeConnection();
  if(!allowDuplicate && (await records(checked.connection)).some(record=>canonicalSource(String(readValue(record,checked,'url')))===canonicalSource(source.url))) return {message:'这篇原文已有保存结果。另存一份会保留旧结果及人工修改。',duplicate:true};
  const partitioned=planParts(body,source.url);
  const prepared=await prepareImages(body,source.url,partitioned.analysis,testSample);
  const group=crypto.randomUUID();const date=parseFrontMatterDate(source.publishedAt);
  const plan:SavePlan={version:1,group,target:{appToken:checked.connection.appToken,tableId:checked.connection.tableId,fieldIds:checked.connection.fieldIds,url:checked.connection.url},values:{title:source.title,account:source.account??'',url:{text:source.url,link:source.url},publishedAt:date?Date.parse(`${date}T00:00:00+08:00`):null,savedAt:Date.now(),body,tags:fixedTags,images:[],group,part:1,total:1,status:'未完成'},pending:null,completed:false,images:prepared.images,pendingUpload:null,imagesAssociated:false};
  if(testSample)plan.testSample=true;
  const count=partitioned.parts.length;
  const plans=partitioned.parts.map((part,index):SavePlan=>({...plan,values:{...plan.values,body:part.body,part:index+1,total:count,title:count===1?source.title:count===2?`${source.title}（${index===0?'上':'下'}）`:`${source.title}（第 ${index+1}/${count} 篇）`},images:part.imageUrls.map(url=>({...prepared.images.find(image=>image.url===url)!}))}));
  const rootPlan=plans[0];if(plans.length>1)rootPlan.parts=plans.slice(1);
  await persist(rootPlan);return drive(rootPlan,prepared.cache);
 });
}
