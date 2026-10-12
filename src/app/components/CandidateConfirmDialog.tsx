import React, { useEffect, useMemo, useRef } from 'react';
import type { ArticleSnapshot, Session } from '../../shared/types';
import { CANDIDATE_COPY } from '../copy/candidate';
import { Dialog, DialogPortal, DialogBackdrop, DialogPopup } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
 * 依据 Issue #28、#74 与设计简报：
 * 模态签条压在清洗页之上（旧会话在背后渲染并压暗）。
 * 签条名为「换稿通知单」，使用统一 Dialog 基础组件。
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

  // 默认焦点放在「继续当前清洗」，换文章覆盖时亦重置焦点至「继续」
  useEffect(() => {
    continueBtnRef.current?.focus();
  }, [candidateSnapshot]);

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !isReplacing) {
          onContinue();
        }
      }}
      disablePointerDismissal={isReplacing}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          ref={dialogRef as unknown as React.RefObject<HTMLDivElement>}
          render={(popupProps) => (
            <dialog
              {...popupProps}
              open
              className={popupProps.className}
              onCancel={(e) => {
                e.preventDefault();
                if (!isReplacing) {
                  onContinue();
                }
              }}
            />
          )}
          initialFocus={continueBtnRef}
          className={cn(
            'candidate-confirm-dialog fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50',
            'w-[calc(100%-32px)] max-w-[520px] max-h-[calc(100vh-32px)] overflow-y-auto',
            'bg-surface-raised border border-sheet-border rounded-[3px] p-8 sm:p-9 shadow-xl',
            'flex flex-col gap-5 text-ink-primary focus:outline-none'
          )}
          data-testid="candidate-confirm-card"
        >
          {/* 右上角斜置待确认印章 */}
          <div
            className="notice-stamp candidate-stamp absolute top-4 right-4 pointer-events-none select-none border-2 border-vermilion text-vermilion font-serif font-bold text-xs tracking-widest px-2 py-0.5 rounded-xs rotate-[-12deg] opacity-85"
            aria-hidden="true"
          >
            <span>{CANDIDATE_COPY.stamp}</span>
          </div>

          {/* 签条头部 */}
          <div className="notice-header flex flex-col gap-1">
            <span className="notice-sub text-xs font-semibold tracking-wider text-ink-tertiary uppercase">
              {CANDIDATE_COPY.noticeSub}
            </span>
            <h2 className="notice-title text-xl font-bold text-ink-primary leading-tight">
              {CANDIDATE_COPY.noticeTitle}
            </h2>
          </div>

          {/* 签条两栏结构：新稿在上，旧稿在下 */}
          <div className="candidate-sections-container flex flex-col gap-3.5 w-full">
            {/* 新稿栏 */}
            <section
              className="candidate-section candidate-new-section relative border border-sheet-border rounded-xs p-3.5 sm:p-4 bg-sheet-bg flex flex-col gap-2"
              data-testid="candidate-new-section"
            >
              <div className="section-label-badge text-[11px] font-mono font-bold uppercase tracking-wider text-amber-ink mb-0.5">
                {CANDIDATE_COPY.newArticleLabel}
              </div>
              <div className="candidate-article-info flex flex-col gap-1.5">
                <h3 className="candidate-article-title text-base font-semibold text-ink-primary leading-snug break-words">
                  《{candidateSnapshot.source.title || CANDIDATE_COPY.defaultArticleTitle}》
                </h3>
                <div className="candidate-article-meta flex flex-wrap gap-3 text-xs text-ink-secondary">
                  {candidateSnapshot.source.account && (
                    <span className="meta-item">
                      <strong className="text-ink-primary font-semibold">{CANDIDATE_COPY.accountPrefix}</strong>
                      {candidateSnapshot.source.account}
                    </span>
                  )}
                  <span className="meta-item">
                    {CANDIDATE_COPY.totalBlockCount(candidateSnapshot.blocks.length)}
                  </span>
                  <span className="meta-item">
                    <strong className="text-ink-primary font-semibold">{CANDIDATE_COPY.captureTimePrefix}</strong>
                    {formatTimestamp(candidateSnapshot.capturedAt)}
                  </span>
                </div>
              </div>
              {isUnstable && (
                <div
                  className="candidate-unstable-note flex items-center gap-2 bg-prussian-blue-subtle border border-prussian-blue/25 p-2 rounded-xs text-xs text-ink-primary mt-1"
                  data-testid="candidate-unstable-note"
                >
                  <span className="note-badge font-semibold text-prussian-blue">{CANDIDATE_COPY.unstableBadge}</span>
                  <span>{CANDIDATE_COPY.unstableNote}</span>
                </div>
              )}
            </section>

            {/* 旧稿栏 */}
            <section
              className="candidate-section candidate-old-section relative border border-sheet-border rounded-xs p-3.5 sm:p-4 bg-sheet-bg flex flex-col gap-2"
              data-testid="candidate-old-section"
            >
              <div className="section-label-badge text-[11px] font-mono font-bold uppercase tracking-wider text-ink-secondary mb-0.5">
                {CANDIDATE_COPY.oldArticleLabel}
              </div>
              <div className="candidate-article-info flex flex-col gap-1.5">
                <h3 className="candidate-article-title text-base font-semibold text-ink-primary leading-snug break-words">
                  《{session.snapshot.source.title || CANDIDATE_COPY.defaultArticleTitle}》
                </h3>
                <div className="candidate-article-meta flex flex-wrap gap-3 text-xs text-ink-secondary">
                  <span className="meta-item">{CANDIDATE_COPY.excludedCount(excludedCount)}</span>
                  <span className="meta-item">{CANDIDATE_COPY.editedCount(editedCount)}</span>
                  <span className="meta-item">
                    <strong className="text-ink-primary font-semibold">{CANDIDATE_COPY.lastSavedPrefix}</strong>
                    {formatTimestamp(session.savedAt)}
                  </span>
                </div>
              </div>
            </section>
          </div>

          {/* 损失写明为一行朱红文字，放在按钮正上方 */}
          <div
            className="candidate-loss-notice text-[13px] font-semibold text-vermilion leading-relaxed py-1"
            data-testid="candidate-loss-notice"
          >
            {lossNoticeText}
          </div>

          {/* 替换写入失败提示 */}
          {replaceError && (
            <div
              className="candidate-replace-error text-[13px] text-vermilion bg-vermilion-subtle border border-vermilion/30 px-3 py-2 rounded-xs font-medium"
              role="alert"
              data-testid="candidate-replace-error"
            >
              {replaceError}
            </div>
          )}

          {/* 操作按钮组：继续当前清洗排第一并获得默认焦点；替换按钮朱红描边不用实心 */}
          <div className="candidate-actions flex flex-wrap items-center gap-2.5 mt-1">
            <Button
              type="button"
              ref={continueBtnRef}
              className="action-btn action-continue bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse font-semibold border-prussian-blue"
              onClick={onContinue}
              disabled={isReplacing}
              data-testid="candidate-btn-continue"
            >
              {CANDIDATE_COPY.btnContinue}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="action-btn action-replace border-vermilion text-vermilion hover:bg-vermilion-subtle font-semibold"
              onClick={onReplace}
              disabled={isReplacing}
              aria-busy={isReplacing}
              data-testid="candidate-btn-replace"
            >
              {CANDIDATE_COPY.btnReplace}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="action-btn action-return text-ink-secondary hover:text-ink-primary hover:border-ink-secondary"
              onClick={onReturnToOriginal}
              disabled={isReplacing}
              data-testid="candidate-btn-return"
            >
              {CANDIDATE_COPY.btnReturnToOriginal}
            </Button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
};
