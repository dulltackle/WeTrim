import { fetchAllExportImages, type FetchedImageSuccess } from '../export/fetch-images';
import { analyzeMarkdownImages, type ExportImageReference } from '../export/markdown-image-refs';
import { ConnectionError, feishuRequest, FeishuRequestError, hasFeishuPermission, type FeishuConnection } from './connection';
import { TEST_IMAGE_URL, testImage } from './test-sample';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface PlannedImage { url: string; fileName: string; size: number; sha256: string; fileToken?: string }
export type ImageCache = Map<string, FetchedImageSuccess>;
export async function imageDigest(bytes: Uint8Array): Promise<string> {
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2,'0')).join('');
}
async function fetchImages(references: ExportImageReference[], testSample=false): Promise<ImageCache> {
 // 仅独立测试入口的固定资源可使用内置字节；普通文章仍经过原有域名/权限检查。
 const builtin = testSample ? references.filter(reference=>reference.resolvedUrl===TEST_IMAGE_URL) : [];
 const result = await fetchAllExportImages(references.filter(reference=>!builtin.includes(reference)));
 result.succeeded.push(...builtin.map(()=>testImage()));
 if (result.failed.length) throw new ConnectionError(`图片无法下载或地址不受支持：${result.failed.map(image=>image.url).join('、')}。请返回清洗会话处理后再保存。`);
 const oversized = result.succeeded.filter(image=>image.bytes.byteLength > MAX_IMAGE_BYTES);
 if (oversized.length) throw new ConnectionError(`图片超过 20 MiB：${oversized.map(image=>image.url).join('、')}。请返回清洗会话处理；没有写入飞书。`);
 return new Map(result.succeeded.map(image=>[image.url,image]));
}
export async function prepareImages(markdown: string, sourceUrl: string, testSample=false): Promise<{images: PlannedImage[]; cache: ImageCache}> {
 const analysis = analyzeMarkdownImages(markdown,sourceUrl);
 const invalid = analysis.usages.find(usage => !usage.resolvedUrl || !usage.canRewrite || !analysis.references.some(reference => reference.resolvedUrl === usage.resolvedUrl));
 if (invalid) {
  const line = markdown.slice(0,invalid.start).split('\n').length;
  throw new ConnectionError(`图片地址无效或无法解析：第 ${line} 行「${markdown.slice(invalid.start,invalid.end).slice(0,80)}」。请返回清洗会话修复；没有写入飞书。`);
 }
 const references = analysis.references;
 if (references.length > 100) throw new ConnectionError('图片超过单篇 100 个附件预算，本阶段暂不能保存，请等待分篇功能。');
 const cache=await fetchImages(references,testSample);
 const images:PlannedImage[]=[];
 for(const reference of references){const image=cache.get(reference.resolvedUrl)!;images.push({url:image.url,fileName:image.fileName,size:image.bytes.length,sha256:await imageDigest(image.bytes)});}
 return {images,cache};
}
export async function sourceBytes(image: PlannedImage, cache: ImageCache, testSample=false): Promise<FetchedImageSuccess> {
 let fetched=cache.get(image.url);
 if(!fetched){const references:ExportImageReference[]=[{index:1,fileBaseName:'image-001',rawUrl:image.url,resolvedUrl:image.url,alt:''}];fetched=(await fetchImages(references,testSample)).get(image.url)!;cache.set(image.url,fetched);}
 if(fetched.bytes.length!==image.size||await imageDigest(fetched.bytes)!==image.sha256)throw new ConnectionError(`图片源内容已变化：${image.url}。原次保存已暂停，不会混入新图片。`);
 return fetched;
}
export async function uploadImage(connection: FeishuConnection,image:PlannedImage,bytes:Uint8Array):Promise<string>{
 const form=new FormData();form.set('file_name',image.fileName);form.set('parent_type','bitable_image');form.set('parent_node',connection.appToken);form.set('size',String(bytes.length));form.set('file',new Blob([Uint8Array.from(bytes).buffer]),image.fileName);
 const result=await feishuRequest<{file_token:string}>(connection,'/drive/v1/medias/upload_all',{method:'POST',body:form});
 if(!result||typeof result.file_token!=='string'||!result.file_token)throw new FeishuRequestError('图片上传回执缺失，保存结果待确认，不会重复上传。',true);
 return result.file_token;
}
/** 下载契约采用官方 SDK 的 extra.bitablePerm（字段 ID → 记录 ID → token 列表）。 */
export async function verifyUploadedImage(connection:FeishuConnection,image:PlannedImage,recordId?:string):Promise<void>{
 if(!image.fileToken)throw new ConnectionError('图片缺少上传回执，保存结果待确认。');
 if(!await hasFeishuPermission())throw new ConnectionError('浏览器飞书权限不可用，请重新检查连接。');
 const extra=recordId?`?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:connection.tableId,attachments:{[connection.fieldIds.images]:{[recordId]:[image.fileToken]}}}}))}`:'';
 let response:Response;
 try{response=await fetch(`https://base-api.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(image.fileToken)}/download${extra}`,{headers:{Authorization:`Bearer ${connection.token}`},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new ConnectionError(`图片副本暂不可读取：${image.url}。已暂停，不会重新上传。`);}
 if(!response.ok)throw new ConnectionError(`图片副本无法读取：${image.url}。请检查飞书权限后重试，不会重新上传。`);
 let bytes:Uint8Array;
 try{bytes=new Uint8Array(await response.arrayBuffer());}catch{throw new ConnectionError(`图片副本下载未完成：${image.url}，请重试核对。`);}
 if(bytes.length!==image.size||await imageDigest(bytes)!==image.sha256)throw new ConnectionError(`图片副本内容不一致：${image.url}。已暂停，不会覆盖。`);
}
