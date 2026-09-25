import React, { useEffect, useMemo, useRef } from 'react';
import type { ArticleSnapshot, Session } from '../../shared/types';
import { CANDIDATE_COPY } from '../copy/candidate';

export interface CandidateConfirmDialogProps {
  candidateSnapshot: ArticleSnapshot;
  session: Session;
  replaceError: string | null;
  /** 替换写入进行中：禁用「继续」与「替换」，Esc 也不生效 */
  isReplacing: boolean;
  onContinue: () => void;
  onReplace: () => void;
  onReturnToOriginal: () => void;
}

function formatTimestamp(isoString?: string | null): string {
  if (!isoString) return '--';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch {
    return isoString;
  }
}

/**
 * 依据 Issue #28 与设计简报：
 * 模态签条压在清洗页之上（旧会话在背后渲染并压暗）。
 * 签条名为「换稿通知单」，使用原生 <dialog> 的 showModal()。
 * 沿用退单卡 / 异常卡的结构语法，右上角放斜置「待确认」印章。
 * 父组件只在候选确认态挂载本组件，挂载即打开、卸载即关闭。
 */
export const CandidateConfirmDialog: React.FC<CandidateConfirmDialogProps> = ({
  candidateSnapshot,
  session,
  replaceError,
  isReplacing,
  onContinue,
  onReplace,
  onReturnToOriginal,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const continueBtnRef = useRef<HTMLButtonElement | null>(null);

  // 旧稿已剔除与已编辑块数统计（口径与 BlockItem 一致：editedMarkdown !== null 即为已修改）
  const excludedCount = useMemo(
    () => session.snapshot.blocks.filter((b) => !b.included).length,
    [session.snapshot.blocks]
  );
  const editedCount = useMemo(
    () => session.snapshot.blocks.filter((b) => b.editedMarkdown !== null).length,
    [session.snapshot.blocks]
  );

  const isSameUrl = session.snapshot.source.url === candidateSnapshot.source.url;
  const isUnstable = candidateSnapshot.captureWarnings?.some(
    (w) => w.code === 'capture-unstable' || w.code === 'unstable-capture'
  );

  const lossNoticeText = useMemo(() => {
    return CANDIDATE_COPY.formatLossNotice({
      isSameUrl,
      oldTitle: session.snapshot.source.title || CANDIDATE_COPY.defaultArticleTitle,
      excludedCount,
      editedCount,
    });
  }, [isSameUrl, session.snapshot.source.title, excludedCount, editedCount]);

  // 以模态方式打开原生 <dialog>，并聚焦于第一操作「继续」
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) {
      dialog.showModal();
    }
    // 默认焦点放在「继续当前清洗」，换文章覆盖时亦重置焦点至「继续」
    continueBtnRef.current?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [candidateSnapshot]);

  return (
    <dialog
      ref={dialogRef}
      className="candidate-confirm-dialog"
      data-testid="candidate-confirm-card"
      onCancel={(e) => {
        // Esc 等同于「继续」；替换进行中不响应
        e.preventDefault();
        if (!isReplacing) {
          onContinue();
        }
      }}
    >
      {/* 右上角斜置待确认印章 */}
      <div className="notice-stamp candidate-stamp" aria-hidden="true">
        <span>{CANDIDATE_COPY.stamp}</span>
      </div>

      {/* 签条头部 */}
      <div className="notice-header">
        <span className="notice-sub">{CANDIDATE_COPY.noticeSub}</span>
        <h2 className="notice-title">{CANDIDATE_COPY.noticeTitle}</h2>
      </div>

      {/* 签条两栏结构：新稿在上，旧稿在下 */}
      <div className="candidate-sections-container">
        {/* 新稿栏 */}
        <section className="candidate-section candidate-new-section" data-testid="candidate-new-section">
          <div className="section-label-badge">{CANDIDATE_COPY.newArticleLabel}</div>
          <div className="candidate-article-info">
            <h3 className="candidate-article-title">
              《{candidateSnapshot.source.title || CANDIDATE_COPY.defaultArticleTitle}》
            </h3>
            <div className="candidate-article-meta">
              {candidateSnapshot.source.account && (
                <span className="meta-item">
                  <strong>{CANDIDATE_COPY.accountPrefix}</strong>
                  {candidateSnapshot.source.account}
                </span>
              )}
              <span className="meta-item">
                {CANDIDATE_COPY.totalBlockCount(candidateSnapshot.blocks.length)}
              </span>
              <span className="meta-item">
                <strong>{CANDIDATE_COPY.captureTimePrefix}</strong>
                {formatTimestamp(candidateSnapshot.capturedAt)}
              </span>
            </div>
          </div>
          {isUnstable && (
            <div className="candidate-unstable-note" data-testid="candidate-unstable-note">
              <span className="note-badge">{CANDIDATE_COPY.unstableBadge}</span>
              <span>{CANDIDATE_COPY.unstableNote}</span>
            </div>
          )}
        </section>

        {/* 旧稿栏 */}
        <section className="candidate-section candidate-old-section" data-testid="candidate-old-section">
          <div className="section-label-badge">{CANDIDATE_COPY.oldArticleLabel}</div>
          <div className="candidate-article-info">
            <h3 className="candidate-article-title">
              《{session.snapshot.source.title || CANDIDATE_COPY.defaultArticleTitle}》
            </h3>
            <div className="candidate-article-meta">
              <span className="meta-item">{CANDIDATE_COPY.excludedCount(excludedCount)}</span>
              <span className="meta-item">{CANDIDATE_COPY.editedCount(editedCount)}</span>
              <span className="meta-item">
                <strong>{CANDIDATE_COPY.lastSavedPrefix}</strong>
                {formatTimestamp(session.savedAt)}
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* 损失写明为一行朱红文字，放在按钮正上方 */}
      <div className="candidate-loss-notice" data-testid="candidate-loss-notice">
        {lossNoticeText}
      </div>

      {/* 替换写入失败提示 */}
      {replaceError && (
        <div className="candidate-replace-error" role="alert" data-testid="candidate-replace-error">
          {replaceError}
        </div>
      )}

      {/* 操作按钮组：继续当前清洗排第一并获得默认焦点；替换按钮朱红描边不用实心 */}
      <div className="candidate-actions">
        <button
          type="button"
          ref={continueBtnRef}
          className="action-btn action-continue"
          onClick={onContinue}
          disabled={isReplacing}
          data-testid="candidate-btn-continue"
        >
          {CANDIDATE_COPY.btnContinue}
        </button>
        <button
          type="button"
          className="action-btn action-replace"
          onClick={onReplace}
          disabled={isReplacing}
          aria-busy={isReplacing}
          data-testid="candidate-btn-replace"
        >
          {CANDIDATE_COPY.btnReplace}
        </button>
        <button
          type="button"
          className="action-btn action-return"
          onClick={onReturnToOriginal}
          data-testid="candidate-btn-return"
        >
          {CANDIDATE_COPY.btnReturnToOriginal}
        </button>
      </div>
    </dialog>
  );
};
