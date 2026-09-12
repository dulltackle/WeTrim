import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * 组装 Turndown 转换实例
 * 依据 ARCHITECTURE.md §6.1：Turndown 作为基座，turndown-plugin-gfm 提供表格支持
 */
export function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  turndown.use(gfm);
  return turndown;
}

export const turndownService = createTurndown();

/**
 * 启动自检模块：生产构建下真实调用一次 Turndown 与 GFM 表格转换，
 * 验证其生产构建完全不依赖 eval 或 unsafe-eval
 */
export function verifyTurndownTable(): string {
  const htmlFixture = `<table><thead><tr><th>测试列1</th><th>测试列2</th></tr></thead><tbody><tr><td>值A</td><td>值B</td></tr></tbody></table>`;
  return turndownService.turndown(htmlFixture);
}
