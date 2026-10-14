import { useEffect, useRef, useState } from 'react';
import type { ArticleSnapshot } from '../../shared/types';
import { TagPicker } from './TagPicker';
import {
  abandonSave,
  saveAsNew,
  readSave,
  retrySave,
  startSave,
  type SavePlan,
  type SaveResult,
} from './save';
import { Button } from '@/components/ui/button';

export function SavePanel({
  getSnapshot,
}: {
  getSnapshot: () => ArticleSnapshot | undefined;
}) {
  const [recovery, setRecovery] = useState<SavePlan | null>(null);
  const [confirm, setConfirm] = useState<'abandon' | 'copy' | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const duplicateTags = useRef<string[]>([]);
  const [result, setResult] = useState<SaveResult>({ message: '' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const duplicateSnapshot = useRef<ArticleSnapshot | null>(null);

  useEffect(() => {
    void readSave()
      .then((plan) => {
        if (plan && !plan.completed) {
          setRecovery(plan);
          setResult({
            message: '有未完成的飞书保存，可核对并继续原次保存。',
            plan,
          });
        }
      })
      .catch(() => setResult({ message: '本机飞书进度无法读取，已暂停。' }));
  }, []);

  async function run(mode: 'new' | 'duplicate' | 'retry') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const snapshot = mode === 'duplicate' ? duplicateSnapshot.current : getSnapshot();
      setResult({ message: mode === 'retry' ? '正在核对原次保存…' : '正在保存到飞书…' });
      const next =
        mode === 'retry'
          ? await retrySave()
          : snapshot
          ? await startSave(
              snapshot,
              mode === 'duplicate',
              mode === 'duplicate' ? duplicateTags.current : tags
            )
          : { message: '没有可保存的文章。' };
      duplicateSnapshot.current = next.duplicate && snapshot ? structuredClone(snapshot) : null;
      if (next.duplicate) duplicateTags.current = [...tags];
      setResult(next);
      try {
        const saved = await readSave();
        setRecovery(saved && !saved.completed ? saved : null);
      } catch {
        /* 保留已知进度，不把读取失败当作没有。 */
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function finishRecovery(mode: 'abandon' | 'copy') {
    if (inFlight.current || !recovery) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const next = await (mode === 'abandon'
        ? abandonSave(recovery.group)
        : saveAsNew(recovery.group));
      setResult(next);
      setConfirm(null);
      const saved = await readSave();
      setRecovery(saved && !saved.completed ? saved : null);
    } catch {
      setResult({ message: '本机进度暂时无法读取，请重试。' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="feishu-save-panel p-4 sm:p-6 border-b border-sheet-border bg-sheet-bg" aria-label="飞书保存">
      <TagPicker
        value={tags}
        onChange={(value) =>
          setTags([...new Set(value.map((tag) => tag.trim()).filter(Boolean))])
        }
        disabled={busy}
      />
      <div className="feishu-save-actions flex flex-wrap gap-3 my-3">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="action-btn action-preview font-medium h-8 text-xs bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
          data-feishu-save
          disabled={busy}
          onClick={() => void run('new')}
        >
          保存到飞书
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="action-btn action-preview font-medium h-8 text-xs"
          data-feishu-retry
          disabled={busy}
          onClick={() => void run('retry')}
        >
          核对并继续原次保存
        </Button>
      </div>
      <p role="status" data-feishu-save-status className="text-xs text-ink-secondary mt-2 leading-relaxed">
        {result.message}
      </p>
      {recovery && (
        <div className="feishu-recovery-actions mt-4 p-4 border border-sheet-border rounded-sm bg-surface-raised">
          <p className="text-xs text-ink-secondary m-0 mb-3 leading-relaxed">
            恢复使用原次固定内容。已上传图片先核对，尚未上传的图片需要重新获取；图片源失效时保存会保持未完成。
          </p>
          <div className="flex flex-wrap gap-3 mb-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="action-btn action-preview font-medium h-8 text-xs"
              data-feishu-copy-recovery
              disabled={busy}
              onClick={() => setConfirm('copy')}
            >
              另存原次完整内容
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="action-btn action-preview font-medium h-8 text-xs text-vermilion hover:text-vermilion"
              data-feishu-abandon
              disabled={busy}
              onClick={() => setConfirm('abandon')}
            >
              放弃这次保存
            </Button>
          </div>
          {confirm === 'copy' && (
            <div data-feishu-recovery-confirm className="p-3 bg-sheet-bg border border-sheet-border rounded-[2px] mt-2">
              <p className="text-xs text-ink-secondary m-0 mb-2 leading-relaxed">
                使用原次固定内容另存完整一份，不含后续清洗编辑。原次远端结果和人工修改都会保留；本机恢复进度改为新的一次保存。
              </p>
              <div className="feishu-save-actions flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="action-btn action-preview font-medium h-7 text-xs bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
                  data-feishu-copy-confirm
                  disabled={busy}
                  onClick={() => void finishRecovery('copy')}
                >
                  确认另存完整一份
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="action-btn action-preview font-medium h-7 text-xs"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
          {confirm === 'abandon' && (
            <div data-feishu-recovery-confirm className="p-3 bg-sheet-bg border border-sheet-border rounded-[2px] mt-2">
              <p className="text-xs text-ink-secondary m-0 mb-2 leading-relaxed">
                仅清除本机恢复内容；清洗会话、连接和远端部分都会保留。远端记录及图片需要你到飞书自行查看、删除。
              </p>
              <div className="feishu-save-actions flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="action-btn action-preview font-medium h-7 text-xs bg-vermilion hover:bg-vermilion-strong text-ink-inverse"
                  data-feishu-abandon-confirm
                  disabled={busy}
                  onClick={() => void finishRecovery('abandon')}
                >
                  确认放弃本机进度
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="action-btn action-preview font-medium h-7 text-xs"
                  data-feishu-abandon-cancel
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {result.duplicate && (
        <div className="mt-3 p-3 bg-surface-raised border border-sheet-border rounded-sm flex flex-wrap gap-3 items-center">
          <Button
            type="button"
            variant="default"
            size="sm"
            className="action-btn action-preview font-medium h-8 text-xs bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
            data-feishu-duplicate
            disabled={busy}
            onClick={() => void run('duplicate')}
          >
            保留旧结果，另存一份
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="action-btn action-preview font-medium h-8 text-xs"
            onClick={() => {
              duplicateSnapshot.current = null;
              setResult({ message: '已取消，没有写入飞书。' });
            }}
          >
            取消
          </Button>
        </div>
      )}
    </section>
  );
}
