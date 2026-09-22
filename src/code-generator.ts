import { toDataURL } from 'qrcode';
import JsBarcode from 'jsbarcode';
import JSZip from 'jszip';

export type CodeKind = 'qr' | 'barcode';

export interface BarcodeFormatOption {
  value: string;
  label: string;
  hint: string;
}

/** JsBarcode 支持的常用一维码格式 */
export const BARCODE_FORMATS: BarcodeFormatOption[] = [
  {
    value: 'CODE128',
    label: 'CODE128',
    hint: '最通用，支持任意 ASCII 字符（英文、数字、符号），内容长度不限',
  },
  {
    value: 'CODE39',
    label: 'CODE39',
    hint: '仅支持大写英文字母 A-Z、数字 0-9 及 - . $ / + % 空格',
  },
  {
    value: 'EAN13',
    label: 'EAN-13',
    hint: '商品零售条码，内容需为 12 或 13 位纯数字',
  },
  {
    value: 'EAN8',
    label: 'EAN-8',
    hint: '小商品零售条码，内容需为 7 或 8 位纯数字',
  },
  {
    value: 'UPC',
    label: 'UPC-A',
    hint: '北美地区商品条码，内容需为 11 或 12 位纯数字',
  },
  {
    value: 'ITF14',
    label: 'ITF-14',
    hint: '物流外箱条码，内容需为 13 或 14 位纯数字',
  },
];

export interface CodeResult {
  recordId: string;
  /** 实际编码的文本 */
  text: string;
  fileName: string;
  dataUrl?: string;
  error?: string;
}

/**
 * 生成二维码（PNG data URL）
 */
export function renderQRCode(text: string): Promise<string> {
  return toDataURL(text, {
    width: 600,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * 生成一维条形码（PNG data URL）；内容不符合格式要求时 JsBarcode 会抛错
 */
export function renderBarcode(text: string, format: string, displayText: boolean): string {
  const canvas = document.createElement('canvas');
  // 去除换行符，一维码不支持多行内容
  const cleanText = text.replace(/[\r\n]+/g, ' ').trim();
  try {
    JsBarcode(canvas, cleanText, {
      format,
      width: 2,
      height: 120,
      displayValue: displayText,
      fontSize: 20,
      margin: 14,
      textMargin: 6,
      background: '#ffffff',
      lineColor: '#000000',
    });
  } catch (error) {
    // JsBarcode 抛出的错误信息可能不够友好，补充格式校验提示
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(`${format} 编码失败：${raw}。请检查内容是否符合该格式的字符要求。`);
  }
  return canvas.toDataURL('image/png');
}

/**
 * 根据编码内容生成安全的图片文件名
 */
export function buildFileName(kind: CodeKind, index: number, text: string): string {
  const prefix = kind === 'qr' ? 'qrcode' : 'barcode';
  const cleaned = text
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  const num = String(index + 1).padStart(3, '0');
  return `${prefix}_${num}${cleaned ? `_${cleaned}` : ''}.png`;
}

/**
 * 触发浏览器下载
 */
function triggerDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  triggerDownload(dataUrl, fileName);
}

/**
 * 将成功生成的图片打包为 ZIP 下载（自动处理重名）
 */
export async function downloadZip(results: CodeResult[], zipName: string): Promise<void> {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  for (const result of results) {
    if (!result.dataUrl) continue;
    let name = result.fileName;
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf('.');
      const base = name.slice(0, dot);
      const ext = name.slice(dot);
      let seq = 2;
      while (usedNames.has(`${base}_${seq}${ext}`)) seq += 1;
      name = `${base}_${seq}${ext}`;
    }
    usedNames.add(name);
    const base64 = result.dataUrl.split(',')[1] ?? '';
    zip.file(name, base64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, zipName);
  } finally {
    // 保留短延时确保下载已开始
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
