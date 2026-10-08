import { Lexer } from 'marked';
import { analyzeMarkdownImages, type MarkdownImageAnalysis } from '../export/markdown-image-refs';
import { ConnectionError } from './connection';

export interface PlannedPart { body: string; imageUrls: string[] }
/** 只解析整篇图片；分段后的代码/引用定义不重新解释。每段拼回时逐字符等于输入。 */
export function planParts(body: string, sourceUrl: string): {parts:PlannedPart[]; analysis:MarkdownImageAnalysis} {
 const analysis=analyzeMarkdownImages(body,sourceUrl);
 const protectedRanges=[...analysis.usages,...analysis.usages.flatMap(usage=>usage.definition?[usage.definition]:[])];
 const preferred:number[]=[];let cursor=0;
 for(const token of Lexer.lex(body)){
  const start=body.indexOf(token.raw,cursor);if(start<0)continue;
  cursor=start+token.raw.length;preferred.push(cursor);
 }
 // 按code point构造合法边界，同时精确累计JSON转义UTF-16成本（含孤立代理项）。
 const boundaries=[0],costs=[0];let offset=0,cost=0;
 for(const character of body){offset+=character.length;cost+=JSON.stringify(character).length-2;boundaries.push(offset);costs.push(cost);}
 const parts:PlannedPart[]=[];let start=0,startIndex=0;
 while(start<body.length){
  let low=startIndex+1,high=boundaries.length-1,last=startIndex;
  while(low<=high){const mid=(low+high)>>1;if(costs[mid]-costs[startIndex]<=90000){last=mid;low=mid+1;}else high=mid-1;}
  let end=boundaries[last];
  const resources=new Set<string>();
  for(const usage of analysis.usages){if(usage.start<start||usage.start>=end)continue;resources.add(usage.resolvedUrl);if(resources.size>100){end=usage.start;break;}}
  // 不拆图片语法、引用定义或代理对；无法容纳的单一语法明确拒绝。
  let changed=true;while(changed){changed=false;for(const range of protectedRanges)if(range.start<end&&range.end>end){end=range.start;changed=true;}}
  if(end<=start)throw new ConnectionError(`第 ${body.slice(0,start).split('\n').length} 行图片或引用定义无法在单篇预算内完整保留，已暂停；不会降级为附件。`);
  if(end<body.length){const boundary=preferred.filter(value=>value>start&&value<=end&&!protectedRanges.some(range=>range.start<value&&range.end>value)).at(-1);if(boundary!==undefined)end=boundary;}
  const imageUrls=[...new Set(analysis.usages.filter(usage=>usage.start>=start&&usage.start<end).map(usage=>usage.resolvedUrl))];
  parts.push({body:body.slice(start,end),imageUrls});start=end;
  // end来自原文token/usage边界，正常为code point边界；异常时拒绝而不截断。
  let left=startIndex,right=boundaries.length-1;while(left<=right){const mid=(left+right)>>1;if(boundaries[mid]<start)left=mid+1;else right=mid-1;}startIndex=left;
  if(boundaries[startIndex]!==start)throw new ConnectionError('分篇边界无法保留完整字符，已暂停。');
 }
 return {parts,analysis};
}
