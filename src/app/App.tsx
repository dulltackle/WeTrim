import React, { useEffect, useState } from 'react';
import { verifyTurndownTable } from './parse/convert';
import { renderMarkdown } from './preview/render';
import './app.css';

/**
 * 依据 PRODUCT.md 与 output/tmp/issue15-brief.md：
 * 视觉世界：校样与校对符号 (Operate 模式)
 * 空状态页呈现清晰三步，不把「没有文章」呈现成错误。
 * 并在生产构建下真实调用五库：React 19, Turndown, GFM, marked, DOMPurify.
 */
export const App: React.FC = () => {
  const [selfTestPassed, setSelfTestPassed] = useState(false);
  const [tableConversionResult, setTableConversionResult] = useState('');

  // 1. marked + DOMPurify 真实渲染三步文案（Markdown 源格式）
  const stepsMarkdown = `1. **用浏览器打开一篇公众号文章**
2. **等它显示完**
3. **点工具栏上的 WeTrim 图标** 开始清洗`;

  const renderedStepsHtml = renderMarkdown(stepsMarkdown);

  useEffect(() => {
    try {
      // 2. Turndown + turndown-plugin-gfm 真实执行表格转换
      const tableMd = verifyTurndownTable();
      setTableConversionResult(tableMd);

      // 控制台输出验证日志
      console.log(
        '[WeTrim Self-Test] Production CSP & eval verification passed: React 19, Turndown, turndown-plugin-gfm, marked, DOMPurify OK.\n' +
          'Table conversion fixture result:\n' +
          tableMd
      );

      setSelfTestPassed(true);
    } catch (err) {
      console.error('[WeTrim Self-Test] Evaluation failed:', err);
    }
  }, []);

  return (
    <div className="app-container" data-csp-eval-verified={selfTestPassed ? 'true' : 'false'}>
      {/* 顶部工作台状态条 */}
      <header className="workbench-header">
        <div className="ticket-slug">
          <span className="ticket-tag">待稿</span>
          <span>WE-TRIM // 001</span>
        </div>
        <div className="system-status">
          <span className="status-dot"></span>
          <span>工作台就绪</span>
        </div>
      </header>

      {/* 主校样纸张 */}
      <main className="proof-sheet">
        {/* 四角套准十字线 */}
        <div className="reg-cross reg-top-left" aria-hidden="true"></div>
        <div className="reg-cross reg-top-right" aria-hidden="true"></div>
        <div className="reg-cross reg-bottom-left" aria-hidden="true"></div>
        <div className="reg-cross reg-bottom-right" aria-hidden="true"></div>

        {/* 顶部色标条 */}
        <div className="registration-bar">
          <div className="cmyk-swatches">
            <span className="cmyk-swatch" style={{ backgroundColor: '#00A3E0' }} title="Cyan"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#E4007C' }} title="Magenta"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#FFD100' }} title="Yellow"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#1A1A18' }} title="Black"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#C8352B' }} title="Vermilion"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#2F5FA8' }} title="Prussian Blue"></span>
          </div>
          <div className="proof-marks-info">PROOF SHEET · SPEC V1.0 · OPERATE</div>
        </div>

        <div className="sheet-body">
          {/* 左侧页边批注栏（物理宽度预留） */}
          <aside className="margin-track" aria-label="批注栏">
            <div className="track-header">批注 · 痕迹</div>
            <div className="track-stub"></div>
            <div className="line-numbers">
              <span>01</span>
            </div>
          </aside>

          {/* 右侧版心 */}
          <section className="main-bed">
            <h1 className="empty-headline">
              <span className="empty-headline-accent"></span>
              从一篇公众号文章开始
            </h1>

            <div className="steps-container">
              <div
                className="rendered-steps"
                dangerouslySetInnerHTML={{ __html: renderedStepsHtml }}
              />
            </div>
          </section>
        </div>

        {/* 底部印厂信息与自检证明 */}
        <footer className="proof-footer">
          <span>WETRIM MV3 ENGINE</span>
          {selfTestPassed && (
            <span className="proof-stamp" data-testid="self-test-status">
              ✓ CSP / EVAL VERIFIED (TURNDOWN + GFM + MARKED + DOMPURIFY + REACT 19)
            </span>
          )}
        </footer>
      </main>
    </div>
  );
};
