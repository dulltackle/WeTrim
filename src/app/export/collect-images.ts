import type { Block, ImageAsset } from '../../shared/types';
import { resolveImageUrl } from '../parse/rules/wechat';

/**
 * 从内容块中收集图片资源（对应 docs/conversion-rules.md §4.8 与 ARCHITECTURE.md §5）:
 * 1. data-src 有值时优先于 src
 * 2. 原样保留全部查询参数，不归一化尺寸、格式或签名参数
 * 3. 相对地址按文章 URL 解析为绝对地址
 * 4. 按完整 URL 字符串去重（不做内容哈希）
 * 5. wx_fmt 只用于猜扩展名，不修改 URL
 */
export function collectImages(blocks: Block[], baseUrl?: string): ImageAsset[] {
  if (typeof DOMParser === 'undefined') {
    return [];
  }

  const parser = new DOMParser();
  const seenUrls = new Set<string>();
  const imageAssets: ImageAsset[] = [];

  for (const block of blocks) {
    if (!block.originalHtml || !block.originalHtml.includes('<img')) {
      continue;
    }

    try {
      const doc = parser.parseFromString(block.originalHtml, 'text/html');
      const imgs = doc.querySelectorAll('img');

      for (const img of Array.from(imgs)) {
        const url = resolveImageUrl(img, baseUrl);
        if (!url) continue;

        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          imageAssets.push({
            id: crypto.randomUUID(),
            url,
          });
        }
      }
    } catch {
      // 容错：个别块的 DOM 解析失败不中断整篇图片收集
    }
  }

  return imageAssets;
}
