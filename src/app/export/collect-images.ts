import type { Block, ImageAsset } from '../../shared/types';
import { resolveImageUrl, resolveUrlString } from '../parse/rules/wechat';

/**
 * 从内容块中收集图片资源（对应 docs/conversion-rules.md §4.8 与 ARCHITECTURE.md §5）:
 * 1. data-src 有值时优先于 src
 * 2. 原样保留全部查询参数，不归一化尺寸、格式或签名参数
 * 3. 相对地址按文章 URL 解析为绝对地址
 * 4. 按完整 URL 字符串去重（不做内容哈希）
 * 5. wx_fmt 只用于猜扩展名，不修改 URL
 * 6. 支持从富媒体卡片属性（mp-common-profile 头像、mp-common-miniprogram 封面）收集图片资源
 */
export function collectImages(blocks: Block[], baseUrl?: string): ImageAsset[] {
  if (typeof DOMParser === 'undefined') {
    return [];
  }

  const parser = new DOMParser();
  const seenUrls = new Set<string>();
  const imageAssets: ImageAsset[] = [];

  for (const block of blocks) {
    if (!block.originalHtml) {
      continue;
    }

    const html = block.originalHtml;
    const mightHaveImages =
      html.includes('<img') ||
      html.includes('mp-common-profile') ||
      html.includes('mpprofile') ||
      html.includes('mp-common-miniprogram') ||
      html.includes('mp-miniprogram') ||
      html.includes('data-headimg');

    if (!mightHaveImages) {
      continue;
    }

    try {
      const doc = parser.parseFromString(html, 'text/html');

      const addAsset = (rawUrl: string | null) => {
        if (!rawUrl) return;
        const url = resolveUrlString(rawUrl.trim(), baseUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          imageAssets.push({
            id: crypto.randomUUID(),
            url,
          });
        }
      };

      // 1. 标准 <img> 标签
      const imgs = doc.querySelectorAll('img');
      for (const img of Array.from(imgs)) {
        const url = resolveImageUrl(img, baseUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          imageAssets.push({
            id: crypto.randomUUID(),
            url,
          });
        }
      }

      // 2. 公众号名片头像属性（data-headimg, data-headimgurl）
      const profiles = doc.querySelectorAll('mp-common-profile, mpprofile');
      for (const p of Array.from(profiles)) {
        addAsset(p.getAttribute('data-headimg') || p.getAttribute('data-headimgurl'));
      }

      // 3. 小程序卡片封面属性（data-miniprogram-imageurl, data-miniprogram-headimg）
      const miniprograms = doc.querySelectorAll('mp-common-miniprogram, mp-miniprogram');
      for (const mp of Array.from(miniprograms)) {
        addAsset(
          mp.getAttribute('data-miniprogram-imageurl') ||
          mp.getAttribute('data-miniprogram-headimg')
        );
      }
    } catch {
      // 容错：个别块的 DOM 解析失败不中断整篇图片收集
    }
  }

  return imageAssets;
}
