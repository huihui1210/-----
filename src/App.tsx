import { useCallback, useEffect, useRef, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';
import { getSelectionInfo, getSelectedData, cellToText } from './bitable-helper';
import type { SelectionInfo } from './bitable-helper';
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

export default function App() {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  // SDK 在宿主环境外可能既不 resolve 也不 reject，因此启动时先同步检测一次
  const [notInHost, setNotInHost] = useState(detectNotInHost);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [kind, setKind] = useState<CodeKind>('qr');
  const [barcodeFormat, setBarcodeFormat] = useState<string>('CODE128');
  const [fieldId, setFieldId] = useState<string>('');
  const [displayText, setDisplayText] = useState(true);

  const [results, setResults] = useState<CodeResult[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [zipping, setZipping] = useState(false);

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

  // 当前选中字段在可见列中失效时，回退到第一列
  useEffect(() => {
    const columns = selection?.columns ?? [];
    if (columns.length > 0 && !columns.some((col) => col.id === fieldId)) {
      setFieldId(columns[0].id);
    }
  }, [selection, fieldId]);

  const handleGenerate = async () => {
    setNotice(null);
    try {
      const data = await getSelectedData();
      if (data.rows.length === 0) {
        setNotice({ type: 'warning', text: '请先在「表格」视图中勾选至少一条记录。' });
        return;
      }
      const column = data.columns.find((col) => col.id === fieldId) ?? data.columns[0];
      if (!column) {
        setNotice({ type: 'error', text: '当前视图没有可用的内容字段。' });
        return;
      }

      setGenerating(true);
      setResults([]);
      setProgress({ done: 0, total: data.rows.length });

      const collected: CodeResult[] = [];
      for (let i = 0; i < data.rows.length; i += 1) {
        const row = data.rows[i];
        const text = cellToText(row.fields[column.id], column.type).trim();
        const fileName = buildFileName(kind, i, text);

        if (!text) {
          collected.push({
            recordId: row.recordId,
            text: '',
            fileName,
            error: '该记录的此字段内容为空，已跳过',
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
      setNotice({
        type: failCount > 0 ? 'warning' : 'success',
        text:
          failCount > 0
            ? `生成完成：成功 ${successCount} 条，${failCount} 条失败或为空，请查看下方列表。`
            : `已成功生成 ${successCount} 张图片，可单张下载或打包下载。`,
      });
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

  const columns = selection?.columns ?? [];
  const successCount = results.filter((item) => item.dataUrl).length;
  const currentHint = BARCODE_FORMATS.find((item) => item.value === barcodeFormat)?.hint;
  const recordCount = checking ? 0 : selection?.count ?? 0;

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
          <label className="form-label" htmlFor="code-kind">
            图片类型
          </label>
          <div className="segmented" id="code-kind">
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
          <label className="form-label" htmlFor="content-field">
            内容字段
          </label>
          <select
            id="content-field"
            className="select"
            value={fieldId}
            disabled={columns.length === 0}
            onChange={(event) => setFieldId(event.target.value)}
          >
            {columns.length === 0 && <option value="">暂无可选字段</option>}
            {columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}
              </option>
            ))}
          </select>
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

      <button
        type="button"
        className="primary-btn"
        disabled={generating || recordCount === 0}
        onClick={() => void handleGenerate()}
      >
        {generating && progress
          ? `生成中 ${progress.done} / ${progress.total}`
          : `生成${kind === 'qr' ? '二维码' : '条形码'}（${recordCount} 条）`}
      </button>

      {notice && <div className={`banner banner-${notice.type}`}>{notice.text}</div>}

      {results.length > 0 && (
        <section className="card results-card">
          <div className="results-head">
            <span className="card-label">
              生成结果：成功 {successCount} / 共 {results.length}
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
            {results.map((item, index) => (
              <div className="result-item" key={item.recordId}>
                {item.dataUrl ? (
                  <>
                    <div className="code-img">
                      <img src={item.dataUrl} alt={item.text} />
                    </div>
                    <div className="result-meta">
                      <span className="result-text" title={item.text}>
                        {item.text || '(空)'}
                      </span>
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
                  </>
                ) : (
                  <div className="result-error">
                    <span className="result-index">第 {index + 1} 条</span>
                    {item.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="tips">
        使用方法：在「表格」视图中勾选记录 → 选择内容字段与类型 → 点击生成。
        所有数据仅在当前页面处理，不会上传到外部服务器。
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
