/** 有状态飞书网络替身；只拦截 API，不替换产品保存/恢复内部逻辑。 */
export function feishuFixture() {
 const names = ['标题','公众号名称','原文链接','原文发布日期','保存时间','正文','标签','图片','文章关联标识','分篇序号','分篇总数','保存状态'];
 const types = [1,1,15,5,5,1,4,17,1,2,2,3];
 const fields = names.map((name,i) => ({field_id:`fld${i}`,field_name:name,type:types[i],property:i===11?{options:[{name:'未完成'},{name:'已完成'}]}:{}}));
 const server = { records:[], writes:0, fault:null, hide:false, fields, images:new Map(), uploads:new Map(), uploadCount:0, imageFault:null };
 server.imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 server.install = async page => {
  await page.exposeFunction('__feishuFixtureUpload',async data=>{
   server.writes++;server.uploadCount++;
   if(server.imageFault==='uploadReject'||server.uploadRejectAt===server.uploadCount){server.imageFault=null;return {code:1254000};}
   if(data.parent_type!=='bitable_image'||data.parent_node!=='appFixture'||Number(data.size)!==Buffer.from(data.bytes,'base64').length)throw new Error('上传契约不匹配');
   const token=`file${server.uploadCount}`;server.uploads.set(token,Buffer.from(data.bytes,'base64'));
   if(server.imageFault==='uploadLost'){server.imageFault=null;return null;}
   return {code:0,data:{file_token:token}};
  });
  await page.setRequestInterception(true);
  page.on('request',async request => {
   if(request.url().startsWith('https://mmbiz.qpic.cn/')) {const bytes=server.images.get(request.url())??server.imageBytes;return request.respond(bytes===false?{status:404}:{status:200,headers:{'access-control-allow-origin':'*'},contentType:'image/png',body:bytes});}
   if (!request.url().startsWith('https://base-api.feishu.cn/')) return request.continue();
   const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT'};
   if(request.method()==='OPTIONS') return request.respond({status:204,headers});
   const reply=data=>request.respond({status:200,headers,contentType:'application/json',body:JSON.stringify({code:0,data})});
   const pathname=new URL(request.url()).pathname;
   if(pathname.endsWith('/download')) {const token=pathname.split('/').at(-2);const bytes=server.uploads.get(token);return request.respond(bytes?{status:200,headers,contentType:'image/png',body:bytes}:{status:404,headers});}
   if(pathname.endsWith('/fields')) {
    if(server.failFields) return request.respond({status:503,headers,contentType:'application/json',body:JSON.stringify({code:9999})});
    return reply({items:server.fields,has_more:false});
   }
   if(pathname.endsWith('/tables')) return reply({items:[{table_id:'tblFixture',name:'我的副本'}],has_more:false});
   if(!pathname.includes('/records')) return reply({app:{name:'个人知识库'}});
   if(request.method()==='GET') {const items=server.hide?[]:structuredClone(server.records);if(server.hideAttachments&&items.length)items.at(-1).fields['图片']=[];return reply({items,has_more:false});}
   server.writes++;
   if(server.fault==='reject') {server.fault=null;return request.respond({status:200,headers,contentType:'application/json',body:JSON.stringify({code:1254000,msg:'业务拒绝'})});}
   const payload=JSON.parse(request.postData());
   if(request.method()==='PUT'&&payload.fields['图片']&&server.imageFault==='associateReject'){server.imageFault=null;return request.respond({status:200,headers,contentType:'application/json',body:JSON.stringify({code:1254000})});}
   let record;
   if(request.method()==='POST') { record={record_id:`rec${server.records.length+1}`,fields:payload.fields};server.records.push(record); }
   else {record=server.records.find(r=>r.record_id===pathname.split('/').pop());Object.assign(record.fields,payload.fields);}
   // 原生多选随实际记录写入增加选项，不通过字段写入接口。
   for (const field of server.fields.filter(field=>field.type===4)) {
    for (const name of payload.fields[field.field_name] ?? []) {
     field.property ??= {}; field.property.options ??= [];
     if (!field.property.options.some(option=>option.name===name)) field.property.options.push({name});
    }
   }
   if(request.method()==='PUT'&&payload.fields['图片']&&server.imageFault==='associateLost'){server.imageFault=null;return request.abort('failed');}
   if(server.fault==='malformed') {server.fault=null;return request.respond({status:200,headers,contentType:'application/json',body:'{}'});}
   if(server.onWrite) await server.onWrite(request.method());
   if(server.fault==='lost' || (server.fault==='completeLost' && request.method()==='PUT')) {server.fault=null; return request.abort('failed');}
   return reply({record:structuredClone(record)});
  });
 };
 server.seed = async page => {
  await page.evaluate(async ({names})=> {
   const nativeFetch=window.fetch.bind(window);
   window.fetch=async (url,init)=>{
    if(String(url)==='https://base-api.feishu.cn/open-apis/drive/v1/medias/upload_all'){
     const form=init.body;const bytes=new Uint8Array(await form.get('file').arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
     const result=await window.__feishuFixtureUpload({parent_type:form.get('parent_type'),parent_node:form.get('parent_node'),size:form.get('size'),file_name:form.get('file_name'),bytes:btoa(binary)});
     if(!result)throw new TypeError('模拟上传回执丢失');return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
    }
    return nativeFetch(url,init);
   };
   // 只模拟权限 API 响应，不修改 Chrome 的真实授权状态。
   chrome.permissions.contains=async()=>true;chrome.permissions.request=async()=>true;
   await chrome.storage.local.set({feishuConnection:{appToken:'appFixture',tableId:'tblFixture',url:'https://example.feishu.cn/base/appFixture?table=tblFixture',token:'fixture-not-a-secret',baseName:'个人知识库',tableName:'我的副本',fieldIds:Object.fromEntries(names.map((key,i)=>[key,`fld${i}`]))}});
  },{names:['title','account','url','publishedAt','savedAt','body','tags','images','group','part','total','status']});
 };
 return server;
}
