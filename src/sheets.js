import { google } from 'googleapis';

// Lớp bọc Google Sheets API v4 với các hàm tương đương gspread:
// get_all_values, col_values, update_cells, update_cell, append_row(s), clear, add_rows, row_count

export function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const quoteTitle = (t) => `'${String(t).replace(/'/g, "''")}'`;

export class Worksheet {
  constructor(api, spreadsheetId, props) {
    this.api = api;
    this.spreadsheetId = spreadsheetId;
    this.title = props.title;
    this.sheetId = props.sheetId;
    this.rowCount = props.gridProperties?.rowCount ?? 0;
    this.colCount = props.gridProperties?.columnCount ?? 0;
  }

  get a1() {
    return quoteTitle(this.title);
  }

  // Có ô nào trong vùng (vd 'B2:G') đang là công thức không
  async hasFormulas(range) {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.a1}!${range}`,
      valueRenderOption: 'FORMULA',
    });
    return (res.data.values ?? []).some((r) => r.some((v) => String(v).startsWith('=')));
  }

  // Giống gspread.get_all_values(): mọi hàng được đệm cho bằng độ dài hàng dài nhất
  async getAllValues() {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.a1,
    });
    const rows = res.data.values ?? [];
    let width = 0;
    for (const r of rows) if (r.length > width) width = r.length;
    return rows.map((r) => {
      const out = r.map((v) => (v === null || v === undefined ? '' : String(v)));
      while (out.length < width) out.push('');
      return out;
    });
  }

  // Giống gspread.col_values(col): trả về tới ô có dữ liệu cuối cùng của cột
  async colValues(col) {
    const L = colLetter(col);
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.a1}!${L}:${L}`,
      majorDimension: 'COLUMNS',
    });
    return (res.data.values?.[0] ?? []).map((v) => (v === null || v === undefined ? '' : String(v)));
  }

  // cells: [{ row, col, value }] (1-indexed)
  async updateCells(cells, valueInputOption = 'USER_ENTERED') {
    if (!cells || !cells.length) return;
    const CHUNK = 2000;
    for (let i = 0; i < cells.length; i += CHUNK) {
      const chunk = cells.slice(i, i + CHUNK);
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption,
          data: chunk.map((c) => ({
            range: `${this.a1}!${colLetter(c.col)}${c.row}`,
            values: [[c.value === null || c.value === undefined ? '' : c.value]],
          })),
        },
      });
    }
  }

  async updateCell(row, col, value, valueInputOption = 'USER_ENTERED') {
    return this.updateCells([{ row, col, value }], valueInputOption);
  }

  async appendRows(rows, valueInputOption = 'USER_ENTERED') {
    if (!rows || !rows.length) return;
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.a1}!A1`,
      valueInputOption,
      requestBody: { values: rows },
    });
  }

  async appendRow(row, valueInputOption = 'USER_ENTERED') {
    return this.appendRows([row], valueInputOption);
  }

  // range: phần sau dấu "!" (vd "A2:I"); bỏ trống = xoá cả trang
  async clear(range) {
    await this.api.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: range ? `${this.a1}!${range}` : this.a1,
    });
  }

  // Ghi một khối hình chữ nhật trong 1 request, bắt đầu từ ô startA1 (vd "A2")
  async updateRange(startA1, values, valueInputOption = 'RAW') {
    if (!values || !values.length) return;
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.a1}!${startA1}`,
      valueInputOption,
      requestBody: { values },
    });
  }

  // Gửi thẳng các request định dạng (merge, tô màu, độ rộng cột...) của Sheets API cho tab này
  async batch(requests) {
    if (!requests.length) return;
    await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
  }

  // Xoá hẳn các hàng (số hàng 1-indexed), hàng bên dưới dồn lên. Xoá từ dưới lên để số hàng không lệch nhau.
  async deleteRows(rowNumbers) {
    const rows = [...new Set(rowNumbers)].filter((r) => r >= 1).sort((a, b) => b - a);
    if (!rows.length) return;
    await this.batch(
      rows.map((r) => ({ deleteDimension: { range: { sheetId: this.sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } })),
    );
    this.rowCount -= rows.length;
  }

  async addRows(n) {
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{ appendDimension: { sheetId: this.sheetId, dimension: 'ROWS', length: n } }],
      },
    });
    this.rowCount += n;
  }

  // Mở rộng lưới (thêm hàng/cột) nếu nhỏ hơn kích thước cần ghi. Đọc kích thước thật từ API vì cache có thể cũ.
  async ensureSize(rows, cols) {
    const res = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' });
    const props = (res.data.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === this.sheetId);
    if (props) {
      this.rowCount = props.gridProperties?.rowCount ?? this.rowCount;
      this.colCount = props.gridProperties?.columnCount ?? this.colCount;
    }
    const requests = [];
    if (rows > this.rowCount) {
      requests.push({ appendDimension: { sheetId: this.sheetId, dimension: 'ROWS', length: rows - this.rowCount } });
    }
    if (cols > this.colCount) {
      requests.push({ appendDimension: { sheetId: this.sheetId, dimension: 'COLUMNS', length: cols - this.colCount } });
    }
    if (!requests.length) return;
    await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
    this.rowCount = Math.max(this.rowCount, rows);
    this.colCount = Math.max(this.colCount, cols);
  }
}

export class SheetsClient {
  constructor(credentials) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = google.sheets({ version: 'v4', auth });
    this._meta = new Map(); // spreadsheetId -> [properties]
    this._ws = new Map(); // `${id}::${title}` -> Worksheet
  }

  // Giống client.open_by_key(id).worksheet(title), có cache
  async worksheet(spreadsheetId, title, { refresh = false } = {}) {
    const key = `${spreadsheetId}::${title}`;
    if (!refresh && this._ws.has(key)) return this._ws.get(key);

    let meta = refresh ? null : this._meta.get(spreadsheetId);
    if (!meta) {
      const res = await this.api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
      meta = (res.data.sheets ?? []).map((s) => s.properties);
      this._meta.set(spreadsheetId, meta);
    }
    const props = meta.find((p) => p.title === title);
    if (!props) {
      // Có thể sheet mới được tạo (vd: sheet KPI tuần mới) -> tải lại metadata 1 lần
      if (!refresh) return this.worksheet(spreadsheetId, title, { refresh: true });
      throw new Error(`Không tìm thấy worksheet "${title}"`);
    }
    const ws = new Worksheet(this.api, spreadsheetId, props);
    this._ws.set(key, ws);
    return ws;
  }

  // Lấy tab, chưa có thì tạo mới. Trả về [worksheet, vừaTạo]
  async ensureWorksheet(spreadsheetId, title, { rows = 1000, cols = 26, frozenRows = 1 } = {}) {
    try {
      return [await this.worksheet(spreadsheetId, title), false];
    } catch (e) {
      if (!String(e.message).includes('Không tìm thấy worksheet')) throw e;
    }
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: rows, columnCount: cols, frozenRowCount: frozenRows } } } }],
      },
    });
    this._meta.delete(spreadsheetId);
    return [await this.worksheet(spreadsheetId, title, { refresh: true }), true];
  }
}
