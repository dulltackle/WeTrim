import type { Block } from '../../shared/types';
import { currentMarkdown } from '../../shared/types';

/**
 * 清洗结果（CONTEXT.md 与 Issue #25 验收标准 7）：
 * 按文章原顺序汇集保留块的当前内容所得的正文；剔除块与空白块不进入结果。
 */
export function buildMarkdown(blocks: Block[]): string {
  return blocks
    .filter((b) => b.included && currentMarkdown(b).trim() !== '')
    .map((b) => currentMarkdown(b).trim())
    .join('\n\n');
}
