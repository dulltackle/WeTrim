import { useEffect, useRef, useState } from 'react';
import type { RecoveryState } from '../state/session-reducer';

interface Props {
  recovery: RecoveryState;
  isReadOnly: boolean;
  onRetry: () => Promise<void>;
  onClear: () => Promise<void>;
}

/** 原生对话框保护清除操作；恢复页只负责展示，不自行修改存储。 */
export function RecoveryPanel({ recovery, isReadOnly, onRetry, onClear }: Props) {
  const [deferred, setDeferred] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const restoreClearFocus = useRef(false);
  const loading = recovery.kind === 'loading';
  const readable = recovery.kind === 'unrecognized';

  useEffect(() => { heading.current?.focus(); }, [recovery.kind, deferred]);
  useEffect(() => {
    if (!confirming) {
      if (restoreClearFocus.current) {
        restoreClearFocus.current = false;
        clearButton.current?.focus();
      }
      return;
    }
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => { element?.close(); };
  }, [confirming]);

  const closeConfirmation = () => {
    if (busy.current) return;
    restoreClearFocus.current = true;
    setConfirming(false);
  };
  const clear = async () => {
    if (busy.current || isReadOnly) return;
    busy.current = true;
    setClearing(true);
    setError('');
    try {
      await onClear();
    } catch {
      setError('清除未完成，请重试。尚未确认清空上次进度。');
      restoreClearFocus.current = true;
      setConfirming(false);
    } finally {
      busy.current = false;
      setClearing(false);
    }
  };
  const download = () => {
    if (!readable) return;
    try {
      const blob = new Blob([JSON.stringify(recovery.raw, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'WeTrim-原始进度备份.json';
      anchor.click();
      // 浏览器下载消费 Blob 是异步的，延迟释放；不将点击下载当作已保存完成。
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownloadStatus('已发起下载，请在浏览器的下载记录中确认。');
    } catch {
      setDownloadStatus('未能发起下载，请重试。原记录未被修改。');
    }
  };

  const title = loading ? '正在读取上次进度…' : deferred ? '已暂缓处理上次进度' :
    readable ? '暂时无法恢复上次进度' : '暂时无法读取上次进度，请重试';
  return <section className="corrupted-record-card recovery-panel" data-testid="corrupted-record-card"
    data-recovery-kind={recovery.kind} aria-labelledby="recovery-title" aria-busy={loading}>
    <h2 className="notice-title" id="recovery-title" ref={heading} tabIndex={-1}>{title}</h2>
    <p className="recovery-description">
      {loading ? '读取结果确定前，新文章不会替换上次进度。' :
        deferred ? (readable ? '未清除原记录。你可以关闭此标签页，等待修复后再试。' :
          '尚未读到上次进度，也未执行清除。你可以关闭此标签页，稍后再试。') :
        readable ? '原记录未被修改。你可以先下载备份，保留一份用于排查的副本。' :
          '这不代表数据损坏。尚未读到原记录，目前无法提供备份。'}
    </p>
    {!loading && (deferred ? <div className="notice-actions recovery-actions">
      <button className="action-btn action-return" onClick={() => setDeferred(false)}>继续处理</button>
    </div> : <>
      <div className="notice-actions recovery-actions">
        {!readable && <button className="action-btn action-return" onClick={() => void onRetry()}>重试</button>}
        {readable && <button className="action-btn action-return" onClick={download}>下载原始备份</button>}
        <button className="action-btn action-return" onClick={() => setDeferred(true)}>暂不处理</button>
      </div>
      {readable && <p className="state-placeholder-tip">备份仅供排查，目前不能导入恢复。</p>}
      {downloadStatus && <p role="status">{downloadStatus}</p>}
      {readable && !isReadOnly && <div className="recovery-danger">
        <p className="state-placeholder-tip">建议先下载备份；也可以直接确认清除。</p>
        <button ref={clearButton} className="action-btn action-replace" disabled={clearing}
          onClick={() => { setError(''); setConfirming(true); }}>清除并重新开始</button>
        {error && <p role="alert">{error}</p>}
      </div>}
    </>)}
    {confirming && <dialog ref={dialog} className="candidate-confirm-dialog recovery-confirm"
      aria-labelledby="clear-title" aria-describedby="clear-description"
      onCancel={event => { event.preventDefault(); closeConfirmation(); }}>
      <h2 className="notice-title" id="clear-title">清除上次进度？</h2>
      <p id="clear-description">将删除保存在 WeTrim 中的上次进度，此操作无法撤销。</p>
      <div className="candidate-actions recovery-actions">
        <button ref={cancel} className="action-btn action-return" disabled={clearing} onClick={closeConfirmation}>取消</button>
        <button className="action-btn action-replace" disabled={clearing} onClick={() => void clear()}>
          {clearing ? '正在清除…' : '确认清除'}
        </button>
      </div>
    </dialog>}
  </section>;
}
