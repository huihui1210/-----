import { useCallback, useEffect, useRef, useState } from 'react';
import { bitable, FieldType } from '@lark-base-open/js-sdk';
import { getSelectionInfo, getSelectedData, cellToText, writeImageToCell } from './bitable-helper';
import type { SelectionInfo, ColumnInfo } from './bitable-helper';
import {
  BARCODE_FORMATS,
  renderQRCode,
  renderBarcode,
  buildFileName,
  downloadDataUrl,
  downloadZip,
} from './code-generator';
import type { CodeKind, CodeResult } from './code-generator';
import './styles.css';

type NoticeType = 'info' | 'success' | 'error' | 'warning';
interface Notice {
  type: NoticeType;
  text: string;
}

interface WriteBackResult {
  recordId: string;
  ok: boolean;
  error?: string;
}

export default function App() {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  // SDK 在宿主环境外可能既不 resolve 也不 reject，因此启动时先同步检测一次
  const [notInHost, setNotInHost] = useState(detectNotInHost);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [kind, setKind] = useState<CodeKind>('qr');
  const [barcodeFormat, setBarcodeFormat] = useState<string>('CODE128');
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(new Set());
  const [displayText, setDisplayText] = useState(true);

  // 写回附件相关
  const [writeBackFieldId, setWriteBackFieldId] = useState<string>('');
  const [writeBackMode, setWriteBackMode] = useState<'replace' | 'append'>('replace');
  const [writeBackResults, setWriteBackResults] = useState<WriteBackResult[] | null>(null);

  const [results, setResults] = useState<CodeResult[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [zipping, setZipping] = useState(false);
  const [writingBack, setWritingBack] = useState(false);

  const refreshingRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  /** silent=true 时为后台轮询：不切换 loading/警告状态，仅在结果变化时更新界面 */
  const refresh = useCallback(async (silent = false) => {
    if (refreshingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    refreshingRef.current = true;
    try {
      const info = await getSelectionInfo();
      setSelection((prev) => (isSameSelection(prev, info) ? prev : info));
      if (!silent) setNotInHost(false);
    } catch {
      if (!silent) setNotInHost(detectNotInHost());
    } finally {
      refreshingRef.current = false;
      if (!silent) setChecking(false);
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = bitable.base.onSelectionChange(() => void refresh());
    } catch {
      // 非多维表格环境时忽略
    }
    const pollTimer = window.setInterval(() => void refresh(true), 800);
    return () => {
      unsubscribe();
      window.clearInterval(pollTimer);
    };
  }, [refresh]);

  // 可见列变化时，清理已失效的选中字段
  useEffect(() => {
    const columns = selection?.columns ?? [];
    if (columns.length === 0) return;
    const validIds = new Set(columns.map((col) => col.id));
    setSelectedFieldIds((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selection]);

  const columns = selection?.columns ?? [];
  // 附件类型字段（用于写回图片）
  const attachmentColumns = columns.filter((col) => col.type === FieldType.Attachment);

  // 写回字段失效时重置
  useEffect(() => {
    if (attachmentColumns.length > 0 && !attachmentColumns.some((col) => col.id === writeBackFieldId)) {
      setWriteBackFieldId('');
    }
  }, [attachmentColumns, writeBackFieldId]);

  const toggleField = (id: string) => {
    setSelectedFieldIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedFieldIds((prev) => {
      // 已全选则清空，否则全选
      if (prev.size === columns.length) return new Set();
      return new Set(columns.map((col) => col.id));
    });
  };

  const handleGenerate = async () => {
    setNotice(null);
    setWriteBackResults(null);
    try {
      const data = await getSelectedData();
      if (data.rows.length === 0) {
        setNotice({ type: 'warning', text: '请先在「表格」视图中勾选至少一条记录。' });
        return;
      }

      // 确定参与拼接的内容字段
      const contentFields: ColumnInfo[] = data.columns.filter((col) => selectedFieldIds.has(col.id));
      if (contentFields.length === 0) {
        const first = data.columns[0];
        if (!first) {
          setNotice({ type: 'error', text: '当前视图没有可用的内容字段。' });
          return;
        }
        contentFields.push(first);
      }

      setGenerating(true);
      setResults([]);
      setProgress({ done: 0, total: data.rows.length });

      const collected: CodeResult[] = [];
      for (let i = 0; i < data.rows.length; i += 1) {
        const row = data.rows[i];
        // 多字段内容用换行拼接
        const text = contentFields
          .map((field) => cellToText(row.fields[field.id], field.type).trim())
          .filter(Boolean)
          .join('\n');
        const fileName = buildFileName(kind, i, text.replace(/\n/g, ' '));

        if (!text) {
          collected.push({
            recordId: row.recordId,
            text: '',
            fileName,
            error: '该记录的所选字段内容均为空，已跳过',
          });
        } else {
          try {
            const dataUrl =
              kind === 'qr'
                ? await renderQRCode(text)
                : renderBarcode(text, barcodeFormat, displayText);
            collected.push({ recordId: row.recordId, text, fileName, dataUrl });
          } catch (error) {
            collected.push({
              recordId: row.recordId,
              text,
              fileName,
              error: error instanceof Error ? error.message : '生成失败',
            });
          }
        }

        setResults([...collected]);
        setProgress({ done: i + 1, total: data.rows.length });
      }

      const successCount = collected.filter((item) => item.dataUrl).length;
      const failCount = collected.length - successCount;

      // 如果选了写回字段，自动执行写回
      if (writeBackFieldId && successCount > 0) {
        await doWriteBack(collected);
      } else {
        setNotice({
          type: failCount > 0 ? 'warning' : 'success',
          text:
            failCount > 0
              ? `生成完成：成功 ${successCount} 条，${failCount} 条失败或为空，请查看下方列表。`
              : `已成功生成 ${successCount} 张图片，可单张下载或打包下载。`,
        });
      }
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : '操作失败，请确认插件运行在多维表格边栏中。',
      });
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  };

  const doWriteBack = async (items: CodeResult[]) => {
    const selectionData = await getSelectionInfo().catch(() => null);
    const tableId = (await bitable.base.getSelection()).tableId;
    if (!tableId) return;

    const writable = items.filter((item) => item.dataUrl);
    if (writable.length === 0) return;

    setWritingBack(true);
    const wbResults: WriteBackResult[] = [];
    let okCount = 0;
    for (let i = 0; i < writable.length; i += 1) {
      const item = writable[i];
      try {
        await writeImageToCell({
          tableId,
          fieldId: writeBackFieldId,
          recordId: item.recordId,
          dataUrl: item.dataUrl!,
          fileName: item.fileName,
          mode: writeBackMode,
        });
        wbResults.push({ recordId: item.recordId, ok: true });
        okCount += 1;
      } catch (error) {
        wbResults.push({
          recordId: item.recordId,
          ok: false,
          error: error instanceof Error ? error.message : '写入失败',
        });
      }
    }
    setWriteBackResults(wbResults);
    setWritingBack(false);

    const failCount = writable.length - okCount;
    setNotice({
      type: failCount > 0 ? 'warning' : 'success',
      text:
        failCount > 0
          ? `生成并写入完成：成功 ${okCount} 条，${failCount} 条写入失败。`
          : `已成功生成并写入 ${okCount} 张图片到附件字段。`,
    });
    void selectionData;
  };

  const handleDownloadZip = async () => {
    if (results.every((item) => !item.dataUrl)) return;
    setZipping(true);
    try {
      await downloadZip(results, buildZipName(kind));
    } catch {
      setNotice({ type: 'error', text: '打包下载失败，请重试或改用单张下载。' });
    } finally {
      setZipping(false);
    }
  };

  const successCount = results.filter((item) => item.dataUrl).length;
  const currentHint = BARCODE_FORMATS.find((item) => item.value === barcodeFormat)?.hint;
  const recordCount = checking ? 0 : selection?.count ?? 0;
  const allSelected = selectedFieldIds.size > 0 && selectedFieldIds.size === columns.length;

  // 写回结果的映射，用于在结果列表中显示状态
  const writeBackMap = new Map<string, WriteBackResult>();
  if (writeBackResults) {
    for (const item of writeBackResults) {
      writeBackMap.set(item.recordId, item);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="#fff"
              d="M3 4h3v16H3V4zm4 0h2v16H7V4zm3 0h1v16h-1V4zm2 0h3v16h-3V4zm4 0h1v16h-1V4zm2 0h3v16h-3V4z"
            />
          </svg>
        </div>
        <div>
          <h1>条码 / 二维码生成</h1>
          <p className="subtitle">将勾选记录的字段内容生成图片</p>
        </div>
      </header>

      {notInHost && (
        <div className="banner banner-warning">
          当前页面未运行在多维表格边栏中。请在多维表格里通过「插件 → 自定义插件」添加本服务地址。
        </div>
      )}

      <section className="card">
        <div className="card-top">
          <span className="card-label">当前选中</span>
          <button type="button" className="text-btn" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <div className="selection-main">
          <span className="count-badge">{checking ? '…' : recordCount}</span>
          <span className="count-unit">条记录</span>
        </div>
        <p className="location">
          {selection ? `${selection.tableName} / ${selection.viewName}` : '未检测到数据表'}
        </p>
      </section>

      <section className="card">
        <div className="form-item">
          <label className="form-label">图片类型</label>
          <div className="segmented">
            <button
              type="button"
              className={kind === 'qr' ? 'segmented-btn active' : 'segmented-btn'}
              onClick={() => setKind('qr')}
            >
              二维码
            </button>
            <button
              type="button"
              className={kind === 'barcode' ? 'segmented-btn active' : 'segmented-btn'}
              onClick={() => setKind('barcode')}
            >
              条形码
            </button>
          </div>
        </div>

        <div className="form-item">
          <div className="field-head">
            <label className="form-label">内容字段（可多选）</label>
            {columns.length > 0 && (
              <button type="button" className="text-btn" onClick={toggleSelectAll}>
                {allSelected ? '取消全选' : '全选'}
              </button>
            )}
          </div>
          {columns.length === 0 ? (
            <p className="hint-line">当前视图没有可见字段</p>
          ) : (
            <div className="field-list">
              {columns.map((col) => (
                <label key={col.id} className="field-check">
                  <input
                    type="checkbox"
                    checked={selectedFieldIds.has(col.id)}
                    onChange={() => toggleField(col.id)}
                  />
                  <span className="field-check-name">{col.name}</span>
                </label>
              ))}
            </div>
          )}
          {selectedFieldIds.size > 1 && (
            <p className="hint-line">已选 {selectedFieldIds.size} 个字段，内容将按换行拼接</p>
          )}
        </div>

        {kind === 'barcode' && (
          <>
            <div className="form-item">
              <label className="form-label" htmlFor="barcode-format">
                编码格式
              </label>
              <select
                id="barcode-format"
                className="select"
                value={barcodeFormat}
                onChange={(event) => setBarcodeFormat(event.target.value)}
              >
                {BARCODE_FORMATS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            {currentHint && <p className="hint-line">{currentHint}</p>}
            <label className="check-row">
              <input
                type="checkbox"
                checked={displayText}
                onChange={(event) => setDisplayText(event.target.checked)}
              />
              在条码下方显示内容文字
            </label>
          </>
        )}
      </section>

      <section className="card">
        <div className="form-item">
          <label className="form-label" htmlFor="writeback-field">
            写入附件字段（可选）
          </label>
          {attachmentColumns.length === 0 ? (
            <p className="hint-line">当前视图没有附件类型字段，如需写回请在表中添加「附件」字段</p>
          ) : (
            <select
              id="writeback-field"
              className="select"
              value={writeBackFieldId}
              onChange={(event) => setWriteBackFieldId(event.target.value)}
            >
              <option value="">不写入，仅下载</option>
              {attachmentColumns.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {writeBackFieldId && (
          <div className="form-item">
            <label className="form-label">写入方式</label>
            <div className="segmented">
              <button
                type="button"
                className={writeBackMode === 'replace' ? 'segmented-btn active' : 'segmented-btn'}
                onClick={() => setWriteBackMode('replace')}
              >
                覆盖原有
              </button>
              <button
                type="button"
                className={writeBackMode === 'append' ? 'segmented-btn active' : 'segmented-btn'}
                onClick={() => setWriteBackMode('append')}
              >
                追加
              </button>
            </div>
          </div>
        )}
      </section>

      <button
        type="button"
        className="primary-btn"
        disabled={generating || recordCount === 0}
        onClick={() => void handleGenerate()}
      >
        {generating && progress
          ? `生成中 ${progress.done} / ${progress.total}`
          : writeBackFieldId
            ? `生成并写入${kind === 'qr' ? '二维码' : '条形码'}（${recordCount} 条）`
            : `生成${kind === 'qr' ? '二维码' : '条形码'}（${recordCount} 条）`}
      </button>

      {writingBack && (
        <div className="banner banner-info">正在将图片写入附件字段…</div>
      )}

      {notice && <div className={`banner banner-${notice.type}`}>{notice.text}</div>}

      {results.length > 0 && (
        <section className="card results-card">
          <div className="results-head">
            <span className="card-label">
              生成结果：成功 {successCount} / 共 {results.length}
              {writeBackResults && ` ｜ 写入完成 ${writeBackResults.filter((w) => w.ok).length} 条`}
            </span>
            <button
              type="button"
              className="zip-btn"
              disabled={zipping || successCount === 0}
              onClick={() => void handleDownloadZip()}
            >
              {zipping ? '打包中…' : '打包下载 ZIP'}
            </button>
          </div>
          <div className="result-list">
            {results.map((item, index) => {
              const wb = writeBackMap.get(item.recordId);
              return (
                <div className="result-item" key={item.recordId}>
                  {item.dataUrl ? (
                    <>
                      <div className="code-img">
                        <img src={item.dataUrl} alt={item.text} />
                      </div>
                      <div className="result-meta">
                        <span className="result-text" title={item.text}>
                          {item.text.replace(/\n/g, ' · ') || '(空)'}
                        </span>
                        <div className="result-actions">
                          {wb && (
                            <span className={wb.ok ? 'wb-tag wb-ok' : 'wb-tag wb-fail'}>
                              {wb.ok ? '已写入' : '写入失败'}
                            </span>
                          )}
                          <button
                            type="button"
                            className="mini-btn"
                            onClick={() => {
                              if (item.dataUrl) downloadDataUrl(item.dataUrl, item.fileName);
                            }}
                          >
                            下载
                          </button>
                        </div>
                      </div>
                      {wb && !wb.ok && wb.error && (
                        <p className="wb-error-line">{wb.error}</p>
                      )}
                    </>
                  ) : (
                    <div className="result-error">
                      <span className="result-index">第 {index + 1} 条</span>
                      {item.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <p className="tips">
        使用方法：在「表格」视图中勾选记录 → 选择内容字段与类型 → 点击生成。
        可选「写入附件字段」将图片自动写入记录的附件列。所有数据仅在当前页面处理。
      </p>
    </div>
  );
}

/** 检测当前页面是否运行在多维表格边栏 iframe 之外 */
function detectNotInHost(): boolean {
  try {
    return window.top === window;
  } catch {
    // 跨域无法访问 window.top，说明页面处于 iframe 中，即宿主环境
    return false;
  }
}

function isSameSelection(prev: SelectionInfo | null, next: SelectionInfo): boolean {
  if (!prev) return false;
  return (
    prev.count === next.count &&
    prev.tableName === next.tableName &&
    prev.viewName === next.viewName &&
    prev.multiSelectSupported === next.multiSelectSupported &&
    prev.columns.map((col) => col.id).join('|') === next.columns.map((col) => col.id).join('|')
  );
}

function buildZipName(kind: CodeKind): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}`;
  return `${kind === 'qr' ? '二维码' : '条形码'}_${stamp}.zip`;
}
