import type { ArticleSnapshot } from '../../shared/types';
import type { FetchedImageSuccess } from '../export/fetch-images';

export const TEST_IMAGE_URL = 'https://wetrim.invalid/test-image.png';
export const TEST_BODY = `这是 WeTrim 的测试正文，不包含你的文章内容。\n\n请在图片列打开蓝色测试图片，确认后手动删除此测试记录。\n\n![蓝色测试图片](${TEST_IMAGE_URL})`;
/** 内置 16×16 纯色 PNG，无用户内容；只在明确测试保存路径使用，不持久化图片字节。 */
export function testImage(): FetchedImageSuccess {
 const encoded = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQ9kwlCTGMahjVMHw1AACTDckBE5vCVgAAAABJRU5ErkJggg==';
 return {ok:true,url:TEST_IMAGE_URL,bytes:Uint8Array.from(atob(encoded),char=>char.charCodeAt(0)),format:'png',extension:'.png',fileName:'wetrim-test.png'};
}
export function testSnapshot(): ArticleSnapshot {
 return {snapshotId:'wetrim-test',capturedAt:new Date().toISOString(),source:{title:'WeTrim 测试保存（可手动删除）',account:null,publishedAt:null,url:'https://wetrim.invalid/test-save'},blocks:[{id:'wetrim-test-body',order:1,type:'paragraph',originalHtml:'',initialMarkdown:TEST_BODY,editedMarkdown:null,included:true,notes:[]}],images:[],captureWarnings:[]};
}
