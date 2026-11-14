import { Cog } from '../core/Cog.js';
import { SHEET_IDS } from '../config.js';
import { S, cell, nowVN, fmt, hasRole } from '../utils.js';

// Cột của GCPD HOME (dò theo tiêu đề; nếu không thấy thì dùng vị trí mặc định, 0-indexed)
const HOME_COLS = {
  cs: { header: 'CS', fallback: 1 }, // B
  momo: { header: 'MOMO', fallback: 2 }, // C
  name: { header: 'SĨ QUAN', fallback: 3 }, // D
  chucVu: { header: 'CHỨC VỤ', fallback: 4 }, // E
  roleIc: { header: 'ROLE IC', fallback: 7 }, // H
};

// Người có CHỨC VỤ hoặc ROLE IC chứa cụm này coi như đã nghỉ -> không đưa vào Online
const FIRED_RE = /sa\s*thải/i;

// Mỗi ngày 00:00 giờ VN, hoặc bằng !updategcpdhome:
//  1. Copy toàn bộ "GCPD HOME" -> "Danh-Sach-PD"
//  2. Dựng lại danh sách A-G của sheet "Online" từ GCPD HOME, GIỮ NGUYÊN Ghi chú (F), Duty (H), Radio (I) theo Momo ID
export default class SyncGCPD extends Cog {
  constructor(bot) {
    super(bot);
    this.commands = { updategcpdhome: (ctx) => this.forceSync(ctx) };
    // 00:00 VN = 17:00 UTC
    this.dailyAtUTC('daily_sync_task', 17, 0, () => this.dailySync());
  }

  async copyToDanhSach(data) {
    const dest = await this.bot.gs.worksheet(SHEET_IDS.MAIN, 'Danh-Sach-PD');
    await dest.clear();
    // GCPD HOME có thể dài hơn lưới mặc định 1000x26 của Danh-Sach-PD -> nới rộng trước khi ghi
    const width = data.reduce((w, row) => Math.max(w, row.length), 0);
    await dest.ensureSize(data.length, width);

    const cells = [];
    data.forEach((row, r) =>
      row.forEach((v, c) => {
        const s = String(v).trim();
        if (s) cells.push(cell(r + 1, c + 1, s));
      }),
    );
    if (cells.length) await dest.updateCells(cells);
  }

  // Tìm dòng tiêu đề (dòng đầu có ô "MOMO") và vị trí từng cột
  resolveHomeColumns(data) {
    const norm = (v) => S(v).toUpperCase().replace(/\s+/g, ' ');
    const headerIdx = data.findIndex((row) => row.some((v) => norm(v) === 'MOMO'));
    const header = headerIdx >= 0 ? data[headerIdx].map(norm) : [];
    const cols = {};
    for (const [key, { header: h, fallback }] of Object.entries(HOME_COLS)) {
      const i = header.indexOf(h);
      cols[key] = i >= 0 ? i : fallback;
    }
    return { headerIdx, cols };
  }

  async syncOnline(data) {
    const online = this.bot.sheets.online;
    const { headerIdx, cols } = this.resolveHomeColumns(data);

    // Giữ lại Ghi chú / Duty / Radio hiện có, khoá theo Momo ID
    const existing = new Map();
    const oldRows = await online.getAllValues();
    oldRows.slice(1).forEach((row) => {
      const momo = S(row[2]);
      if (momo && !existing.has(momo)) existing.set(momo, { note: row[5] ?? '', duty: row[7] ?? '', radio: row[8] ?? '' });
    });

    const out = [];
    const seen = new Set();
    let fired = 0;
    for (const row of data.slice(headerIdx + 1)) {
      const momo = S(row[cols.momo]);
      if (!/^\d+$/.test(momo) || seen.has(momo)) continue; // bỏ dòng trống / dòng phân cách / trùng
      if (FIRED_RE.test(S(row[cols.roleIc])) || FIRED_RE.test(S(row[cols.chucVu]))) {
        fired++;
        continue;
      }
      seen.add(momo);
      const old = existing.get(momo);
      out.push([
        out.length + 1, // A STT
        S(row[cols.cs]), // B Callsign
        momo, // C Momo ID
        S(row[cols.name]), // D Họ tên
        S(row[cols.chucVu]), // E Chức vụ
        old?.note ?? '', // F Ghi chú (giữ nguyên)
        S(row[cols.roleIc]), // G Chức vụ (đơn vị)
        old?.duty ?? '', // H Trạng thái Duty (giữ nguyên)
        old?.radio ?? '', // I Radio (giữ nguyên)
      ]);
    }
    if (!out.length) throw new Error('Không đọc được Momo ID nào từ GCPD HOME (kiểm tra cột MOMO)');

    const added = out.filter((r) => !existing.has(r[2])).length;
    const removed = [...existing.keys()].filter((m) => !seen.has(m)).length;

    await online.ensureSize(out.length + 1, 9);
    await online.clear('A2:I');
    await online.updateRange('A2', out);
    return { total: out.length, added, removed, fired };
  }

  async performSync() {
    try {
      const src = await this.bot.gs.worksheet(SHEET_IDS.HOME, 'GCPD HOME');
      const data = await src.getAllValues();
      if (!data.length) return [false, 'Bảng GCPD HOME hiện đang trống, không có gì để copy!'];

      await this.copyToDanhSach(data);
      const o = await this.syncOnline(data);

      return [
        true,
        `Đã đồng bộ **${data.length} dòng** sang \`Danh-Sach-PD\` và **${o.total} sĩ quan** sang \`Online\` (mới: ${o.added}, đã gỡ: ${o.removed}, bỏ qua bị sa thải: ${o.fired}).`,
      ];
    } catch (e) {
      return [false, e.message];
    }
  }

  async dailySync() {
    console.log(`[${fmt(nowVN(), 'HH:mm:ss')}] Bắt đầu Auto-Sync GCPD HOME...`);
    const [ok, msg] = await this.performSync();
    if (ok) console.log(`✅ Auto-Sync thành công: ${msg}`);
    else console.error(`❌ Auto-Sync thất bại: ${msg}`);
  }

  async forceSync(ctx) {
    const m = ctx.author;
    if (!(hasRole(m, 'Hội Đồng Ủy Ban') || hasRole(m, 'Sở Trưởng Cảnh Sát') || hasRole(m, 'Sở Phó Cảnh Sát'))) {
      return ctx.send('❌ KHÔNG CÓ THẨM QUYỀN!');
    }
    const alert = await ctx.send('⏳ Đang đồng bộ `GCPD HOME` → `Danh-Sach-PD` + `Online`...');
    const [ok, msg] = await this.performSync();
    if (ok) await alert.edit(`✅ **ĐỒNG BỘ HOÀN TẤT:** ${msg}`);
    else await alert.edit(`❌ **LỖI ĐỒNG BỘ:** Lỗi kỹ thuật: \`${msg}\``);
  }
}
