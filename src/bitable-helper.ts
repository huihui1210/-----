import { bitable, FieldType } from '@lark-base-open/js-sdk';
import type { IGridView, IRecord } from '@lark-base-open/js-sdk';

/** 批量读取记录的批次大小（接口单次上限约 1000） */
const CHUNK_SIZE = 500;

export class BaseError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface ColumnInfo {
  id: string;
  name: string;
  type: FieldType;
}

export interface SelectedData {
  columns: ColumnInfo[];
  rows: IRecord[];
  tableName: string;
  viewName: string;
}

export interface SelectionInfo {
  /** 当前选中的记录数 */
  count: number;
  tableName: string;
  viewName: string;
  /** 当前视图是否支持读取多选记录（仅表格视图支持） */
  multiSelectSupported: boolean;
  /** 当前视图的可见列（按视图列顺序） */
  columns: ColumnInfo[];
}

/**
 * 读取当前选中状态（用于面板上的实时提示）
 */
export async function getSelectionInfo(): Promise<SelectionInfo> {
  const selection = await bitable.base.getSelection();
  if (!selection.tableId || !selection.viewId) {
    throw new BaseError('NO_CONTEXT');
  }

  const table = await bitable.base.getTableById(selection.tableId);
  const view = await table.getViewById(selection.viewId);
  const gridView = view as unknown as IGridView;

  let count = 0;
  let multiSelectSupported = false;
  if (typeof gridView.getSelectedRecordIdList === 'function') {
    multiSelectSupported = true;
    const recordIds = await gridView.getSelectedRecordIdList();
    count = recordIds.length;
  } else if (selection.recordId) {
    count = 1;
  }

  const [tableName, viewName, columns] = await Promise.all([
    table.getName(),
    view.getName(),
    getVisibleColumns(view),
  ]);

  return { count, tableName, viewName, multiSelectSupported, columns };
}

/**
 * 读取选中的记录及当前视图的可见列（按视图列顺序）
 */
export async function getSelectedData(): Promise<SelectedData> {
  const selection = await bitable.base.getSelection();
  if (!selection.tableId || !selection.viewId) {
    throw new BaseError('NO_CONTEXT');
  }

  const table = await bitable.base.getTableById(selection.tableId);
  const view = await table.getViewById(selection.viewId);
  const gridView = view as unknown as IGridView;

  let recordIds: string[] = [];
  if (typeof gridView.getSelectedRecordIdList === 'function') {
    recordIds = await gridView.getSelectedRecordIdList();
  } else if (selection.recordId) {
    recordIds = [selection.recordId];
  }

  const [tableName, viewName, columns] = await Promise.all([
    table.getName(),
    view.getName(),
    getVisibleColumns(view),
  ]);

  const rows: IRecord[] = [];
  for (let i = 0; i < recordIds.length; i += CHUNK_SIZE) {
    const chunkIds = recordIds.slice(i, i + CHUNK_SIZE);
    const values = await table.getRecordsByIds(chunkIds);
    values.forEach((value, index) => {
      rows.push({ recordId: chunkIds[index], fields: value.fields });
    });
  }

  return { columns, rows, tableName, viewName };
}

/** 视图仅需暴露的字段读取能力 */
interface ViewLike {
  getFieldMetaList(): Promise<Array<{ id: string; name: string; type: FieldType }>>;
  getVisibleFieldIdList(): Promise<string[]>;
}

/**
 * 读取视图的可见列（丢弃未命名占位字段，按视图列顺序返回）
 */
async function getVisibleColumns(view: ViewLike): Promise<ColumnInfo[]> {
  const [fieldMetas, visibleFieldIds] = await Promise.all([
    view.getFieldMetaList(),
    view.getVisibleFieldIdList(),
  ]);
  const visibleSet = new Set(visibleFieldIds);
  return fieldMetas
    .filter((field) => visibleSet.has(field.id))
    .filter((field) => field.name.trim() !== '')
    .map((field) => ({ id: field.id, name: field.name, type: field.type }));
}

const SEGMENT_TYPES = new Set(['text', 'url', 'mention']);
const DATE_FIELD_TYPES = new Set<FieldType>([
  FieldType.DateTime,
  FieldType.CreatedTime,
  FieldType.ModifiedTime,
]);

/**
 * 将单元格的值转换为可读文本
 */
export function cellToText(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (DATE_FIELD_TYPES.has(type)) return formatDate(value);
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return stringifyArray(value, type);
  return stringifyObject(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyArray(arr: unknown[], type: FieldType): string {
  if (arr.length === 0) return '';
  const records = arr.every(isRecord) ? (arr as Record<string, unknown>[]) : null;
  if (records) {
    if (records.every((item) => SEGMENT_TYPES.has(String(item.type)))) {
      return records
        .map((item) => {
          if (item.type === 'url') {
            const text = String(item.text ?? '');
            const link = String(item.link ?? '');
            return text && link && text !== link ? `${text} ${link}` : text || link;
          }
          return String(item.text ?? '');
        })
        .join('');
    }
    if (records.every((item) => 'token' in item && 'size' in item)) {
      return records.map((item) => String(item.name ?? '')).filter(Boolean).join(', ');
    }
    if (records.every((item) => 'text' in item && 'id' in item && !('recordIds' in item))) {
      return records.map((item) => String(item.text ?? '')).filter(Boolean).join(', ');
    }
    if (records.every((item) => 'email' in item || 'enName' in item)) {
      return records.map((item) => String(item.name ?? '')).filter(Boolean).join(', ');
    }
    if (records.every((item) => 'avatarUrl' in item)) {
      return records.map((item) => String(item.name ?? '')).filter(Boolean).join(', ');
    }
  }
  return arr.map((item) => cellToText(item, type)).filter(Boolean).join(', ');
}

function stringifyObject(obj: unknown): string {
  if (!isRecord(obj)) return String(obj ?? '');
  if ('value' in obj && 'status' in obj) return String(obj.value ?? '');
  if ('recordIds' in obj && 'tableId' in obj) return String(obj.text ?? '');
  if ('text' in obj && 'id' in obj) return String(obj.text ?? '');
  if ('fullAddress' in obj || 'location' in obj) {
    return String(obj.fullAddress || obj.name || obj.location || '');
  }
  if (SEGMENT_TYPES.has(String(obj.type))) return String(obj.text ?? obj.link ?? '');
  if ('text' in obj) return String(obj.text);
  if ('name' in obj) return String(obj.name);
  return '';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (date.getHours() || date.getMinutes() || date.getSeconds()) {
    return `${datePart} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return datePart;
}
