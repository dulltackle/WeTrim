import React, { forwardRef, memo, useCallback, useEffect, useRef, useState } from 'react';
import { currentMarkdown, type Block } from '../../shared/types';
import { truncateGraphemes } from '../../shared/grapheme';
import { renderMarkdown } from '../preview/render';

export interface BlockItemProps {
  block: Block;
  onToggle: (id: string) => void;
  onUpdate?: (id: string, editedMarkdown: string | null) => void;
}

export const BLOCK_TYPE_LABELS: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  image: '图片',
  code: '代码',
  list: '列表',
  quote: '引用',
  table: '表格',
  divider: '分割线',
  formula: '公式',
  richMedia: '富媒体',
  unknown: '未知内容',
};

/**
 * 依据 Issue #24, #25, #27 & 设计简报：
 * - 默认真实阅读态：renderMarkdown 渲染 currentMarkdown(block)
 * - 所有块都可编辑：点击「编辑 Markdown」原地展开源码 <textarea>，初始类型与切块不改变
 * - 空字符串 '' 是有效编辑，用 ?? 不用 ||，不回退到初始内容
 * - 防抖 500ms + 从首次未落盘修改起最长 2s 硬上限必须发起写入
 * - 实时反馈 ≤50ms：编辑中徽章（已修改 / 内容为空）基于本地值同步即时更新
 * - 还原内容：单块编辑区与常驻 meta 操作行均提供，二次内联确认，不改动保留/剔除状态
 * - 纯键盘可达与焦点保持：完成编辑后焦点平稳回落该块，不跳顶
 */
export const BlockItem = memo(
  forwardRef<HTMLDivElement, BlockItemProps>(({ block, onToggle, onUpdate }, ref) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [isConfirmingRestore, setIsConfirmingRestore] = useState(false);
    const [localValue, setLocalValue] = useState(() => currentMarkdown(block));

    const itemContainerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const localValueRef = useRef(localValue);
    localValueRef.current = localValue;

    const isDirtyRef = useRef(false);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const prevEditedMarkdownRef = useRef(block.editedMarkdown);

    // 合并 forwarded ref 与内部 container ref
    const setRefs = useCallback(
      (el: HTMLDivElement | null) => {
        itemContainerRef.current = el;
        if (typeof ref === 'function') {
          ref(el);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      },
      [ref]
    );

    // 提交当前修改
    const flushSave = useCallback(() => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (maxWaitTimerRef.current) {
        clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      if (isDirtyRef.current) {
        isDirtyRef.current = false;
        onUpdate?.(block.id, localValueRef.current);
      }
    }, [block.id, onUpdate]);

    // 外部 block props 同步：当外部 block.editedMarkdown 变更（如还原成功，或外部更新）
    // 且本地无未保存修改时同步。BlockList 以 block.id 作为 key，id 变化必然导致
    // 组件卸载重建，因此这里无需处理块身份变更的场景。
    useEffect(() => {
      if (block.editedMarkdown !== prevEditedMarkdownRef.current && !isDirtyRef.current) {
        const newMd = currentMarkdown(block);
        setLocalValue(newMd);
        localValueRef.current = newMd;
      }
      prevEditedMarkdownRef.current = block.editedMarkdown;
    }, [block.id, block.editedMarkdown, block.initialMarkdown]);

    // 当外部重新包含该块时，若处于折叠态则重置
    useEffect(() => {
      if (block.included) {
        setIsExpanded(false);
      }
    }, [block.included]);

    // 卸载前刷新未保存更改
    useEffect(() => {
      return () => {
        flushSave();
      };
    }, [flushSave]);

    // 文本框输入事件
    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextVal = e.target.value;
      setLocalValue(nextVal);
      localValueRef.current = nextVal;
      isDirtyRef.current = true;

      // 重置 500ms 防抖定时器
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        flushSave();
      }, 500);

      // 首次未保存修改起最长 2s 硬上限定时器
      if (!maxWaitTimerRef.current) {
        maxWaitTimerRef.current = setTimeout(() => {
          flushSave();
        }, 2000);
      }
    };

    // 进入编辑态
    const handleStartEdit = () => {
      if (!block.included && !isExpanded) {
        setIsExpanded(true);
      }
      setIsEditing(true);
      setIsConfirmingRestore(false);
    };

    // 完成编辑
    const handleFinishEdit = () => {
      flushSave();
      setIsEditing(false);
      setIsConfirmingRestore(false);
      setTimeout(() => {
        itemContainerRef.current?.focus();
      }, 0);
    };

    // 启动还原确认
    const handleStartRestore = () => {
      setIsConfirmingRestore(true);
    };

    // 取消还原
    const handleCancelRestore = () => {
      setIsConfirmingRestore(false);
    };

    // 确认还原：恢复初始内容并丢弃当前编辑，不改变保留或剔除状态
    const handleConfirmRestore = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (maxWaitTimerRef.current) {
        clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      isDirtyRef.current = false;
      setLocalValue(block.initialMarkdown);
      localValueRef.current = block.initialMarkdown;
      setIsConfirmingRestore(false);
      setIsEditing(false);
      onUpdate?.(block.id, null);
      setTimeout(() => {
        itemContainerRef.current?.focus();
      }, 0);
    };

    const handleToggle = () => {
      onToggle(block.id);
    };

    const typeLabel = BLOCK_TYPE_LABELS[block.type] || block.type;
    const levelText =
      block.type === 'heading' && block.headingLevel ? ` H${block.headingLevel}` : '';

    // 实时状态计算：在编辑态下以 localValue 为准，阅读态以 currentMarkdown 为准
    const effectiveMarkdown = isEditing ? localValue : currentMarkdown(block);
    const isLocallyEmpty = effectiveMarkdown.trim() === '';
    const isLocallyEdited =
      block.editedMarkdown !== null || (isEditing && localValue !== block.initialMarkdown);

    // 列表、引用、表格为整体块，展示操作提示
    const isComposite = block.type === 'list' || block.type === 'quote' || block.type === 'table';

    const previewText = truncateGraphemes(effectiveMarkdown, 20);
    const summaryPreview = isLocallyEmpty ? '（内容为空）' : previewText;

    const isCollapsed = !block.included && !isExpanded;

    // 整体块提示图标与浮层
    const compositeTip = isComposite ? (
      <span
        className="composite-block-tip-trigger"
        data-testid="composite-block-tip"
        tabIndex={0}
        role="note"
        aria-label="整体取舍，编辑 Markdown 可删改内部内容与图片"
      >
        <svg
          className="tip-icon"
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" />
          <line x1="8" y1="7.5" x2="8" y2="11.5" />
          <circle cx="8" cy="4.75" r="0.5" fill="currentColor" />
        </svg>
        <span className="tip-tooltip" role="tooltip">
          整体取舍，编辑 Markdown 可删改内部内容与图片
        </span>
      </span>
    ) : null;

    // 内联二次确认条
    const inlineRestoreConfirm = (
      <div className="restore-confirm-inline" data-testid="restore-confirm-inline">
        <span className="restore-confirm-tip">
          还原将恢复初始内容并丢弃当前修改，不改变保留/剔除状态
        </span>
        <button
          type="button"
          className="block-action-btn block-action-confirm-restore"
          data-testid="block-action-confirm-restore"
          aria-label={`确认还原第 ${block.order} 块`}
          onClick={handleConfirmRestore}
        >
          确认还原
        </button>
        <button
          type="button"
          className="block-action-btn block-action-cancel-restore"
          data-testid="block-action-cancel-restore"
          aria-label={`取消还原第 ${block.order} 块`}
          onClick={handleCancelRestore}
        >
          取消
        </button>
      </div>
    );

    // 折叠摘要态（剔除且未展开）
    if (isCollapsed) {
      return (
        <div
          ref={setRefs}
          tabIndex={-1}
          className={`block-item block-excluded block-collapsed ${
            isLocallyEdited ? 'block-is-edited' : ''
          } ${isLocallyEmpty ? 'block-is-empty' : ''}`}
          data-testid="block-item"
          data-block-id={block.id}
          data-block-type={block.type}
          data-block-order={block.order}
          data-block-included="false"
          data-block-edited={isLocallyEdited ? 'true' : 'false'}
          data-block-empty={isLocallyEmpty ? 'true' : 'false'}
          data-block-collapsed="true"
          data-block-editing="false"
        >
          <div className="block-item-meta block-collapsed-summary-bar">
            <span className="block-order-badge" data-testid="block-order-badge">
              #{block.order}
            </span>
            <span
              className={`block-type-badge block-type-${block.type}`}
              data-testid="block-type-badge"
            >
              {typeLabel}
              {levelText}
            </span>
            {compositeTip}
            {isLocallyEdited && (
              <span className="block-edited-badge" data-testid="block-edited-badge">
                已修改
              </span>
            )}
            {isLocallyEmpty && (
              <span className="block-empty-badge" data-testid="block-empty-badge">
                内容为空
              </span>
            )}
            <span
              className="block-status-tag status-excluded"
              data-testid="block-status-tag"
            >
              剔除
            </span>

            <span className="block-summary-preview" data-testid="block-summary-preview">
              {summaryPreview}
            </span>

            <div className="block-item-actions">
              <button
                type="button"
                className="block-toggle-btn block-action-restore"
                data-testid="block-action-restore"
                aria-label={`恢复保留第 ${block.order} 块`}
                onClick={handleToggle}
              >
                恢复保留
              </button>

              {isLocallyEdited && (
                isConfirmingRestore ? (
                  inlineRestoreConfirm
                ) : (
                  <button
                    type="button"
                    className="block-action-btn block-action-restore-content"
                    data-testid="block-action-restore-content"
                    aria-label={`还原第 ${block.order} 块内容`}
                    onClick={handleStartRestore}
                  >
                    还原内容
                  </button>
                )
              )}

              <button
                type="button"
                className="block-action-btn block-action-expand"
                data-testid="block-action-expand"
                aria-label={`展开第 ${block.order} 块`}
                onClick={() => setIsExpanded(true)}
              >
                展开
              </button>
              <button
                type="button"
                className="block-action-btn block-action-edit"
                data-testid="block-action-edit"
                aria-label={`编辑第 ${block.order} 块 Markdown`}
                onClick={handleStartEdit}
              >
                编辑 Markdown
              </button>
            </div>
          </div>
        </div>
      );
    }

    // 展开态（保留态，或剔除后点击展开 / 编辑）
    const renderedHtml = !isLocallyEmpty ? renderMarkdown(effectiveMarkdown) : '';

    let contentNode: React.ReactNode;
    if (isEditing) {
      contentNode = (
        <div className="block-editor" data-testid="block-editor">
          <textarea
            ref={textareaRef}
            className="block-editor-textarea"
            data-testid="block-editor-textarea"
            value={localValue}
            onChange={handleTextareaChange}
            aria-label={`编辑第 ${block.order} 块 Markdown`}
            rows={Math.max(3, Math.min(25, localValue.split('\n').length + 1))}
            autoFocus
          />
          <div className="block-editor-toolbar" data-testid="block-editor-toolbar">
            {isLocallyEdited && !isConfirmingRestore && (
              <button
                type="button"
                className="block-action-btn block-action-restore-content"
                data-testid="block-action-restore-content"
                aria-label={`还原第 ${block.order} 块内容`}
                onClick={handleStartRestore}
              >
                还原内容
              </button>
            )}
            {isConfirmingRestore && inlineRestoreConfirm}
            <button
              type="button"
              className="block-action-btn block-action-finish-edit"
              data-testid="block-action-finish-edit"
              aria-label={`完成编辑第 ${block.order} 块`}
              onClick={handleFinishEdit}
            >
              完成编辑
            </button>
          </div>
        </div>
      );
    } else if (isLocallyEmpty) {
      contentNode = (
        <div className="block-empty-placeholder" data-testid="block-empty-placeholder">
          （内容为空）
        </div>
      );
    } else {
      contentNode = (
        <div
          className="block-rendered-content"
          data-testid="block-rendered-content"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      );
    }

    return (
      <div
        ref={setRefs}
        tabIndex={-1}
        className={`block-item ${
          block.included ? 'block-included' : 'block-excluded block-expanded'
        } ${isLocallyEdited ? 'block-is-edited' : ''} ${
          isLocallyEmpty ? 'block-is-empty' : ''
        } ${isEditing ? 'block-is-editing' : ''}`}
        data-testid="block-item"
        data-block-id={block.id}
        data-block-type={block.type}
        data-block-order={block.order}
        data-block-included={block.included ? 'true' : 'false'}
        data-block-edited={isLocallyEdited ? 'true' : 'false'}
        data-block-empty={isLocallyEmpty ? 'true' : 'false'}
        data-block-collapsed="false"
        data-block-editing={isEditing ? 'true' : 'false'}
      >
        {/* 周边文字状态徽章与操作条 */}
        <div className="block-item-meta">
          <span className="block-order-badge" data-testid="block-order-badge">
            #{block.order}
          </span>
          <span
            className={`block-type-badge block-type-${block.type}`}
            data-testid="block-type-badge"
          >
            {typeLabel}
            {levelText}
          </span>
          {compositeTip}
          {isLocallyEdited && (
            <span className="block-edited-badge" data-testid="block-edited-badge">
              已修改
            </span>
          )}
          {isLocallyEmpty && (
            <span className="block-empty-badge" data-testid="block-empty-badge">
              内容为空
            </span>
          )}
          <span
            className={`block-status-tag ${block.included ? 'status-included' : 'status-excluded'}`}
            data-testid="block-status-tag"
          >
            {block.included ? '保留' : '剔除'}
          </span>

          <div className="block-item-actions">
            {block.included ? (
              <button
                type="button"
                className="block-toggle-btn block-action-exclude"
                data-testid="block-action-exclude"
                aria-label={`剔除第 ${block.order} 块`}
                onClick={handleToggle}
              >
                剔除
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="block-toggle-btn block-action-restore"
                  data-testid="block-action-restore"
                  aria-label={`恢复保留第 ${block.order} 块`}
                  onClick={handleToggle}
                >
                  恢复保留
                </button>
                {!isEditing && (
                  <button
                    type="button"
                    className="block-action-btn block-action-collapse"
                    data-testid="block-action-collapse"
                    aria-label={`收起第 ${block.order} 块`}
                    onClick={() => setIsExpanded(false)}
                  >
                    收起
                  </button>
                )}
              </>
            )}

            {/* 还原入口：常驻 meta 操作行 */}
            {isLocallyEdited && (
              isConfirmingRestore ? (
                inlineRestoreConfirm
              ) : (
                <button
                  type="button"
                  className="block-action-btn block-action-restore-content"
                  data-testid="block-action-restore-content"
                  aria-label={`还原第 ${block.order} 块内容`}
                  onClick={handleStartRestore}
                >
                  还原内容
                </button>
              )
            )}

            {/* 编辑与完成编辑入口 */}
            {isEditing ? (
              <button
                type="button"
                className="block-action-btn block-action-finish-edit"
                data-testid="block-action-finish-edit"
                aria-label={`完成编辑第 ${block.order} 块`}
                onClick={handleFinishEdit}
              >
                完成编辑
              </button>
            ) : (
              <button
                type="button"
                className="block-action-btn block-action-edit"
                data-testid="block-action-edit"
                aria-label={`编辑第 ${block.order} 块 Markdown`}
                onClick={handleStartEdit}
              >
                编辑 Markdown
              </button>
            )}
          </div>
        </div>

        {block.notes.length > 0 && (
          <div className="block-notes" data-testid="block-notes">
            {block.notes.map((note, idx) => (
              <div key={`${note.code}-${idx}`} className={`block-note note-code-${note.code}`}>
                <span className="note-badge">提示</span>
                <span className="note-message">{note.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* 内容区：编辑态原地替换为 <textarea>，阅读态渲染语义 HTML */}
        {contentNode}
      </div>
    );
  })
);

BlockItem.displayName = 'BlockItem';
