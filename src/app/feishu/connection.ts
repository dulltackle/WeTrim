/** 飞书个人 Base 连接：只读发现字段；所有错误均使用本地文案，禁止回显响应或凭据。 */
export const FEISHU_ORIGIN = 'https://base-api.feishu.cn/*';
export const CONNECTION_KEY = 'feishuConnection';
export const FIELD_SCHEMA = [
 ['title', '标题', 1], ['account', '公众号名称', 1], ['url', '原文链接', 15],
 ['publishedAt', '原文发布日期', 5], ['savedAt', '保存时间', 5], ['body', '正文', 1],
 ['tags', '标签', 4], ['images', '图片', 17], ['group', '文章关联标识', 1],
 ['part', '分篇序号', 2], ['total', '分篇总数', 2], ['status', '保存状态', 3],
] as const;
export type FieldKey = typeof FIELD_SCHEMA[number][0];
export interface FeishuField { field_id: string; field_name: string; type: number; property?: { options?: { name: string; id?: string }[] } }
export interface FeishuTarget { appToken: string; tableId: string; url: string }
export interface FeishuConnection extends FeishuTarget { token: string; baseName: string; tableName: string; fieldIds: Record<FieldKey, string> }
export interface CheckedConnection { connection: FeishuConnection; fields: Record<FieldKey, FeishuField> }
export class ConnectionError extends Error {}
/** uncertain 表示请求可能生效，必须先核对，不能盲目重发。 */
export class FeishuRequestError extends ConnectionError {
 constructor(message: string, public uncertain: boolean) { super(message); }
}
export function parseTarget(input: string): FeishuTarget {
 const invalid = () => new ConnectionError('链接不受支持。请从飞书多维表格的数据表重新复制含 table 参数的标准链接。');
 let url: URL;
 try { url = new URL(input.trim()); } catch { throw invalid(); }
 const match = /^\/base\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
 const tableId = url.searchParams.get('table');
 if (url.protocol !== 'https:' || url.port || url.username || url.password || !/^(?:[a-z0-9-]+\.)?feishu\.cn$/.test(url.hostname) || !match || !tableId || !/^tbl[a-zA-Z0-9]+$/.test(tableId) || url.searchParams.getAll('table').length !== 1) throw invalid();
 return { appToken: match[1], tableId, url: `${url.origin}/base/${match[1]}?table=${tableId}` };
}
export async function hasFeishuPermission(): Promise<boolean> {
 return chrome.permissions.contains({ origins: [FEISHU_ORIGIN] });
}
export async function readConnection(): Promise<FeishuConnection | null> {
 const stored = await chrome.storage.local.get(CONNECTION_KEY);
 return (stored[CONNECTION_KEY] as FeishuConnection | undefined) ?? null;
}
export async function saveConnection(connection: FeishuConnection): Promise<void> {
 await chrome.storage.local.set({ [CONNECTION_KEY]: connection });
}
export async function feishuRequest<T>(connection: Pick<FeishuConnection, 'token'>, path: string, init: RequestInit = {}): Promise<T> {
 if (!await hasFeishuPermission()) throw new ConnectionError('浏览器尚未允许访问飞书。请点击检查连接并允许权限；仍可继续清洗文章。');
 let response: Response;
 try {
  response = await fetch(`https://base-api.feishu.cn/open-apis${path}`, { ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${connection.token}` }, signal: init.signal ?? AbortSignal.timeout(30000) });
 } catch { throw new FeishuRequestError('飞书网络请求未完成，写入结果需要核对。', true); }
 if (response.status === 401 || response.status === 403) throw new ConnectionError('飞书鉴权失败或目标不可访问，请检查该表的个人授权码与访问权限。');
 let result;
 try { result = await response.json(); } catch { throw new FeishuRequestError('飞书返回无法识别的结果，写入结果需要核对。', true); }
 if (!result || typeof result.code !== 'number') throw new FeishuRequestError('飞书返回缺少业务结果，写入结果需要核对。', true);
 if (!response.ok || result.code !== 0) throw new FeishuRequestError('飞书拒绝请求，请检查个人授权码、目标访问权限及表格配置后重试。', response.status >= 500);
 return result.data as T;
}
async function listAll<T>(connection: Pick<FeishuConnection, 'token'>, path: string): Promise<T[]> {
 const items: T[] = []; const seen = new Set<string>(); let pageToken = '';
 do {
  const page = await feishuRequest<{ items?: T[]; has_more?: boolean; page_token?: string }>(connection, `${path}?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
  if (!Array.isArray(page.items)) throw new ConnectionError('飞书列表不完整，请重新检查。');
  items.push(...page.items);
  if (!page.has_more) return items;
  if (!page.page_token || seen.has(page.page_token)) throw new ConnectionError('飞书列表分页不完整，请重新检查。');
  pageToken = page.page_token; seen.add(pageToken);
 } while (true);
}
export async function checkConnection(target: FeishuTarget, token: string, previous?: FeishuConnection | null): Promise<CheckedConnection> {
 if (!token.trim()) throw new ConnectionError('请填写目标表格的个人授权码。');
 const auth = { token: token.trim() };
 const root = `/bitable/v1/apps/${encodeURIComponent(target.appToken)}`;
 const base = await feishuRequest<{ app: { name: string } }>(auth, root);
 const tables = await listAll<{ table_id: string; name: string }>(auth, `${root}/tables`);
 const table = tables.find(item => item.table_id === target.tableId);
 if (!table) throw new ConnectionError('找不到链接中的数据表，请重新复制目标数据表链接。');
 const available = await listAll<FeishuField>(auth, `${root}/tables/${encodeURIComponent(target.tableId)}/fields`);
 const same = previous?.appToken === target.appToken && previous.tableId === target.tableId;
 const fields = {} as Record<FieldKey, FeishuField>;
 for (const [key, name, type] of FIELD_SCHEMA) {
  const candidates = available.filter(field => same ? field.field_id === previous.fieldIds[key] : field.field_name === name);
  if (candidates.length !== 1) throw new ConnectionError(`${available.length === 11 ? '检测到十一列模板。' : ''}缺少或无法唯一识别「${name}」字段，请修复十二列模板后重新检查。`);
  const field = candidates[0];
  if (field.type !== type) throw new ConnectionError(`「${field.field_name}」字段类型不兼容，请修复后重新检查。`);
  if (key === 'status' && !['未完成', '已完成'].every(option => field.property?.options?.some(item => item.name === option))) throw new ConnectionError('「保存状态」缺少未完成／已完成选项，请修复后重新检查。');
  fields[key] = field;
 }
 return { connection: { ...target, ...auth, baseName: base.app.name, tableName: table.name, fieldIds: Object.fromEntries(FIELD_SCHEMA.map(([key]) => [key, fields[key].field_id])) as Record<FieldKey, string> }, fields };
}
