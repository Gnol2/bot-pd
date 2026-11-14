import { Cog } from '../core/Cog.js';
import { SHEET_IDS } from '../config.js';
import { cell, nowVN, fmt, hasRole } from '../utils.js';

// Copy toàn bộ "GCPD HOME" -> "Danh-Sach-PD" lúc 00:00 giờ VN mỗi ngày, hoặc bằng !updategcpdhome
export default class SyncGCPD extends Cog {
  constructor(bot) {
    super(bot);
    this.commands = { updategcpdhome: (ctx) => this.forceSync(ctx) };
    // 00:00 VN = 17:00 UTC
    this.dailyAtUTC('daily_sync_task', 17, 0, () => this.dailySync());
  }

  async performSync() {
    try {
      const src = await this.bot.gs.worksheet(SHEET_IDS.HOME, 'GCPD HOME');
      const data = await src.getAllValues();
      if (!data.length) return [false, 'Bảng GCPD HOME hiện đang trống, không có gì để copy!'];

      const dest = await this.bot.gs.worksheet(SHEET_IDS.MAIN, 'Danh-Sach-PD');
      await dest.clear();

      const cells = [];
      data.forEach((row, r) =>
        row.forEach((v, c) => {
          const s = String(v).trim();
          if (s) cells.push(cell(r + 1, c + 1, s));
        }),
      );
      if (cells.length) await dest.updateCells(cells);

      return [true, `Đã đồng bộ thành công **${data.length} dòng** từ \`GCPD HOME\` sang \`Danh-Sach-PD\`.`];
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
    const alert = await ctx.send('⏳ Đang truyền tải dữ liệu từ `GCPD HOME` sang `Danh-Sach-PD`...');
    const [ok, msg] = await this.performSync();
    if (ok) await alert.edit(`✅ **ĐỒNG BỘ HOÀN TẤT:** ${msg}`);
    else await alert.edit(`❌ **LỖI ĐỒNG BỘ:** Lỗi kỹ thuật: \`${msg}\``);
  }
}
