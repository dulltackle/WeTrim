import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TestSavePanel } from './TestSavePanel';
import {
  readGeneration,
  GENERATION_KEY,
  CONNECTION_KEY,
  PendingTargetError,
  clearConnection,
  checkConnection,
  ConnectionError,
  FEISHU_ORIGIN,
  FIELD_SCHEMA,
  parseTarget,
  readConnection,
  saveConnection,
  type CheckedConnection,
  type FeishuConnection,
} from './connection';

export function ConnectionSettings() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState<FeishuConnection | null>(null);
  const [checked, setChecked] = useState<CheckedConnection | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const checkedGeneration = useRef('initial');
  const [switching, setSwitching] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function clear() {
    operation.current++;
    setChecked(null);
    try {
      await clearConnection();
      setSaved(null);
      setUrl('');
      setToken('');
      setClearing(false);
      setStatus('已清除本机连接与恢复内容。清洗会话和远端数据均保留。');
    } catch {
      setStatus('本机连接未能清除，请重试。');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    const initial = operation.current;
    void readConnection()
      .then((value) => {
        if (live && operation.current === initial && value) {
          setSaved(value);
          setUrl(value.url);
          setToken(value.token);
          setStatus(`已连接：${value.baseName} / ${value.tableName}。保存前将重新检查字段。`);
        }
      })
      .catch(() => {
        if (live) setStatus('无法读取本机连接，请重试。');
      });

    const revoked = () => {
      operation.current++;
      setChecked(null);
      setBusy(false);
      setStatus('浏览器飞书权限发生变化，请重新检查连接；清洗文章不受影响。');
    };

    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== 'local' || (!changes[CONNECTION_KEY] && !changes[GENERATION_KEY])) return;
      const version = ++operation.current;
      setChecked(null);
      setSwitching(false);
      setBusy(false);
      void readConnection().then((value) => {
        if (!live || version !== operation.current) return;
        setSaved(value);
        setUrl(value?.url ?? '');
        setToken(value?.token ?? '');
      });
    };

    chrome.storage.onChanged.addListener(changed);
    chrome.permissions.onRemoved.addListener(revoked);
    return () => {
      live = false;
      operation.current++;
      chrome.permissions.onRemoved.removeListener(revoked);
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  function invalidate() {
    operation.current++;
    setChecked(null);
    setStatus('');
  }

  async function check(remap = false) {
    if (busy) return;
    const current = ++operation.current;
    setChecked(null);
    setBusy(true);
    try {
      const target = parseTarget(url);
      if (!token.trim()) throw new ConnectionError('请填写目标表格的个人授权码。');
      // 紧接用户点击申请，不能先等待网络或存储而丢失 user gesture。
      const allowed = await chrome.permissions.request({ origins: [FEISHU_ORIGIN] });
      if (!allowed)
        throw new ConnectionError(
          '浏览器未允许访问飞书。可再次点击检查连接申请；清洗文章不受影响。'
        );
      const generation = await readGeneration();
      const result = await checkConnection(target, token, remap ? null : saved);
      if (current === operation.current && generation === (await readGeneration())) {
        checkedGeneration.current = generation;
        setChecked(result);
        setStatus('连接检查通过：仅检查目标和字段，尚未写入任何记录。请确认目标。');
      }
    } catch (error) {
      if (current === operation.current)
        setStatus(error instanceof ConnectionError ? error.message : '连接检查未完成，请重试。');
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }

  async function confirm(abandon = false) {
    if (!checked || busy) return;
    setBusy(true);
    try {
      await saveConnection(checked.connection, abandon, checkedGeneration.current);
      setSwitching(false);
      setSaved(checked.connection);
      setChecked(null);
      setStatus('连接已保存到当前浏览器。未写入飞书记录。');
    } catch (error) {
      if (error instanceof PendingTargetError) setSwitching(true);
      setStatus(
        error instanceof ConnectionError ? error.message : '连接未能保存到当前浏览器，请重试。'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="feishu-settings max-w-[1200px] my-4 mx-auto px-6 text-ink-primary">
      <summary
        data-feishu-settings
        className="cursor-pointer w-fit text-prussian-blue font-semibold hover:text-prussian-blue-strong select-none outline-none focus-visible:ring-2 focus-visible:ring-prussian-blue focus-visible:ring-offset-2 rounded"
      >
        飞书连接
      </summary>
      <div className="mt-4 p-6 bg-sheet-bg border border-sheet-border rounded-lg shadow-sm">
        <h2 className="text-xl font-bold text-ink-primary mb-3">连接你的多维表格</h2>
        <p className="max-w-[70ch] leading-relaxed text-sm text-ink-secondary mb-3">
          <a
            href="https://dulltackle.feishu.cn/base/SKQdbFpCOaipFws5nercV1wwnMe?table=tblrP4IsRN8d2ctW"
            target="_blank"
            rel="noreferrer"
            className="text-prussian-blue underline underline-offset-4 hover:text-prussian-blue-strong"
          >
            打开十二列文章收藏模板
          </a>
          ，从模板菜单选择「创建副本 / Make a Copy」，复制到自己的空间并选择「仅复制结构」。检查副本的访问权限，再从副本的数据表复制链接。
        </p>
        <p className="max-w-[70ch] leading-relaxed text-sm text-ink-secondary mb-3">
          请填写你自己的副本链接和个人授权码，不要向公共母模板保存。授权码可在副本 Base 的扩展工具中获取，仅保存在当前浏览器，不同步。
        </p>
        <form
          className="grid gap-3 max-w-[640px] my-4"
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="feishu-url">目标表格链接</Label>
            <Input
              id="feishu-url"
              type="url"
              required
              value={url}
              disabled={busy}
              onChange={(event) => {
                invalidate();
                setUrl(event.target.value);
              }}
              placeholder="https://你的空间.feishu.cn/base/…?table=…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="feishu-token">个人授权码</Label>
            <Input
              id="feishu-token"
              type="password"
              required
              autoComplete="off"
              value={token}
              disabled={busy}
              onChange={(event) => {
                invalidate();
                setToken(event.target.value);
              }}
            />
          </div>
          <Button type="submit" data-feishu-check disabled={busy} className="w-fit my-2">
            {busy ? '正在检查…' : '检查连接'}
          </Button>
        </form>

        {saved && (
          <div className="my-4 p-4 border border-sheet-border bg-surface-muted rounded-md space-y-2">
            <p className="max-w-[70ch] leading-relaxed text-sm text-ink-secondary">
              如果删除后重新创建了字段，普通检查会暂停。请先恢复十二列的标准名称和类型，再重新识别并确认映射；确认前仍保留原配置。
            </p>
            <Button
              type="button"
              variant="outline"
              data-feishu-remap
              disabled={busy}
              onClick={() => void check(true)}
            >
              按标准列名重新检查映射
            </Button>
          </div>
        )}

        <p role="status" data-feishu-status className="text-sm font-medium text-ink-primary my-2 min-h-[1.5rem]">
          {status}
        </p>

        {checked && (
          <div className="my-4 p-4 border border-prussian-blue-border bg-prussian-blue-subtle/40 rounded-md space-y-3">
            <h3 className="text-base font-semibold text-ink-primary">
              确认目标：{checked.connection.baseName} / {checked.connection.tableName}
            </h3>
            <a
              href={checked.connection.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm text-prussian-blue underline underline-offset-4 hover:text-prussian-blue-strong"
            >
              打开目标表格
            </a>
            <ul className="pl-6 list-disc space-y-1 text-sm text-ink-secondary">
              {FIELD_SCHEMA.map(([key, name]) => (
                <li key={key}>
                  {name} → {checked.fields[key].field_name}（检查通过）
                </li>
              ))}
            </ul>
            <Button
              data-feishu-confirm
              disabled={busy}
              onClick={() => void confirm()}
            >
              确认连接此表格
            </Button>
          </div>
        )}

        {switching && (
          <div
            data-feishu-maintenance
            className="my-4 p-4 border border-amber-border bg-amber-subtle rounded-md space-y-3"
          >
            <p className="text-sm text-amber-ink leading-relaxed">
              原目标还有未完成保存。取消换表后可继续旧保存；确认放弃只清本机恢复内容，保留清洗会话及旧目标远端部分。新目标将创建新的保存记录。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                data-feishu-maintenance-cancel
                onClick={() => setSwitching(false)}
              >
                取消换表，继续旧保存
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-feishu-switch-confirm
                disabled={busy}
                onClick={() => void confirm(true)}
              >
                放弃旧恢复并连接新目标
              </Button>
            </div>
          </div>
        )}

        <div className="my-4">
          <Button
            type="button"
            variant="outline"
            data-feishu-clear
            onClick={() => setClearing(true)}
          >
            清除本机连接
          </Button>
        </div>

        {clearing && (
          <div
            data-feishu-maintenance
            className="my-4 p-4 border border-amber-border bg-amber-subtle rounded-md space-y-3"
          >
            <p className="text-sm text-amber-ink leading-relaxed">
              确认删除本机授权码、目标配置和保存恢复内容？清洗会话和远端数据均保留。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                data-feishu-maintenance-cancel
                onClick={() => setClearing(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-feishu-clear-confirm
                onClick={() => void clear()}
              >
                确认清除本机连接
              </Button>
            </div>
          </div>
        )}

        <p
          data-feishu-revoke-guide
          className="max-w-[70ch] leading-relaxed text-xs text-ink-tertiary mt-3 mb-6"
        >
          本机清除不会撤销飞书授权。请回到飞书目标 Base 获取个人授权码的扩展工具中撤销或重置授权码；远端记录和附件需在飞书自行管理。
        </p>

        <TestSavePanel />
      </div>
    </details>
  );
}
