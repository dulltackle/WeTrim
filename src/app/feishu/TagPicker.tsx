import { useId, useRef, useState } from 'react';
import { checkConnection, ConnectionError, readConnection } from './connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** 标签选择只读取选项；只有正式保存才把选定标签提交给飞书。 */
export function TagPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
}) {
  const id = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [newTag, setNewTag] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function edit() {
    const current = ++generation.current;
    setOpen(true);
    setDraft([...value]);
    setSearch('');
    setNewTag('');
    setLoading(true);
    setError('');
    try {
      const connection = await readConnection();
      if (!connection) throw new ConnectionError('请先检查并确认飞书连接，再选择标签。');
      const checked = await checkConnection(connection, connection.token, connection);
      const available = checked.fields.tags.property?.options ?? [];
      if (!Array.isArray(available) || available.some((option) => typeof option?.name !== 'string')) {
        throw new ConnectionError('标签选项无法读取，请检查标签字段后重新选择。');
      }
      if (current === generation.current) {
        setOptions([...new Set(available.map((option) => option.name.trim()).filter(Boolean))]);
      }
    } catch (cause) {
      if (current === generation.current) {
        setError(cause instanceof ConnectionError ? cause.message : '标签读取失败，请检查连接后重新选择。');
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  function close() {
    ++generation.current;
    setOpen(false);
    setLoading(false);
    opener.current?.focus();
  }

  function add() {
    const tag = newTag.trim();
    if (tag) setDraft((previous) => [...new Set([...previous, tag])]);
    setNewTag('');
  }

  return (
    <div className="feishu-tags mb-3">
      <div className="flex items-center flex-wrap gap-2">
        <Button
          ref={opener}
          type="button"
          variant="outline"
          size="sm"
          className="action-btn action-preview font-medium h-8 text-xs"
          data-feishu-tags-open
          disabled={disabled}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => void edit()}
        >
          选择标签（可选）
        </Button>
        <span className="text-xs text-ink-secondary [overflow-wrap:anywhere]">
          {value.length ? `已选：${value.join('、')}` : '未选择标签'}
        </span>
      </div>

      {open && (
        <fieldset
          id={id}
          disabled={disabled}
          className="border border-sheet-border p-4 mt-3 max-w-[640px] rounded-sm bg-surface-raised max-h-[45vh] overflow-y-auto"
        >
          <legend className="px-1.5 font-semibold text-xs text-ink-primary">文章标签</legend>
          <p id={`${id}-help`} className="text-xs text-ink-secondary m-0">
            可以不选。新标签只随实际保存提交；保存开始后，新建的标签不会自动撤回。
          </p>
          {loading && (
            <p role="status" className="text-xs text-ink-secondary my-2">
              正在读取已有标签…
            </p>
          )}
          {error ? (
            <p role="alert" className="text-xs text-vermilion my-2 font-medium">
              {error}
            </p>
          ) : (
            !loading && (
              <>
                <label className="feishu-tag-field flex flex-col gap-1.5 mt-3 text-xs text-ink-primary font-medium" htmlFor={`${id}-search`}>
                  搜索已有标签
                  <Input
                    id={`${id}-search`}
                    name="tag-search"
                    type="search"
                    data-feishu-tags-search
                    className="w-full bg-sheet-bg border-sheet-border text-ink-primary text-xs h-8"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <div className="feishu-tag-options flex flex-wrap gap-x-4 gap-y-1 my-2">
                  {options
                    .filter((tag) => tag.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
                    .map((tag) => (
                      <label key={tag} className="flex gap-2 items-center min-h-8 text-xs text-ink-primary cursor-pointer select-none">
                        <input
                          type="checkbox"
                          name="article-tag"
                          value={tag}
                          className="rounded-[2px] border-sheet-border accent-prussian-blue"
                          checked={draft.includes(tag)}
                          onChange={(event) =>
                            setDraft(event.target.checked ? [...draft, tag] : draft.filter((item) => item !== tag))
                          }
                        />
                        {tag}
                      </label>
                    ))}
                </div>
                {!options.some((tag) => tag.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (
                  <p className="text-xs text-ink-secondary my-2">没有匹配的已有标签，可以输入新标签。</p>
                )}
                <label className="feishu-tag-field flex flex-col gap-1.5 mt-3 text-xs text-ink-primary font-medium" htmlFor={`${id}-new`}>
                  输入新标签
                  <Input
                    id={`${id}-new`}
                    name="new-tag"
                    data-feishu-tags-new
                    className="w-full bg-sheet-bg border-sheet-border text-ink-primary text-xs h-8"
                    value={newTag}
                    aria-describedby={`${id}-help`}
                    onChange={(event) => setNewTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                </label>
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="action-btn action-preview font-medium h-7 text-xs"
                    data-feishu-tags-add
                    onClick={add}
                  >
                    添加标签
                  </Button>
                </div>
                <p className="text-xs text-ink-primary my-2">
                  本次选择：{draft.length ? draft.join('、') : '不选标签'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="action-btn action-preview font-medium h-7 text-xs"
                  data-feishu-tags-clear
                  onClick={() => {
                    setDraft([]);
                    setNewTag('');
                  }}
                >
                  清空选择
                </Button>
              </>
            )
          )}
          <div className="feishu-save-actions flex flex-wrap gap-3 mt-4">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="action-btn action-preview font-medium h-8 text-xs bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
              data-feishu-tags-apply
              disabled={!!error || loading}
              onClick={() => {
                onChange([...draft, newTag]);
                close();
              }}
            >
              使用这些标签
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="action-btn action-preview font-medium h-8 text-xs"
              data-feishu-tags-cancel
              onClick={close}
            >
              取消选择
            </Button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
