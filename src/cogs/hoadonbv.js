import { Cog } from '../core/Cog.js';
import { ROOMS, SHEET_IDS } from '../config.js';
import { hasRole, nowVN, addMs, DAY_MS, startOfDay, endOfDay, parseDMY, fmt, parseBillEmbed, isBotAdmin, NO_PERM } from '../utils.js';
import { backfillBills } from './hoadon.js';

// Hóa đơn Bệnh viện "Chưa thanh toán" -> sheet Hoa-Don-BV
// (Bản Python không có module này trong cogs_list -> mặc định không load, bật bằng `!load hoadonbv`)
export default class HoaDonBV extends Cog {
  constructor(bot) {
    super(bot);
    this.queue = [];
    this.commands = { updatehoadonbv: (ctx, a, b) => this.updateHoaDonBV(ctx, a, b) };
    this.loop('hoadonbv_batch', 10_000, () => this.batchProcessor());
  }

  getSheet() {
    return this.bot.gs.worksheet(SHEET_IDS.MAIN, 'Hoa-Don-BV');
  }

  async batchProcessor() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 20);
    try {
      const sheet = await this.getSheet();
      await sheet.appendRows(batch);
      console.log(`🚀 [Bus HoaDon-BV] Đã chở sỉ ${batch.length} Hóa đơn [CHƯA THANH TOÁN] lên Sheet an toàn!`);
    } catch (e) {
      console.error('❌ Lỗi chuyến xe buýt Hóa Đơn BV:', e.message);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message) || !message.embeds.length) return;
    if (message.channel.id !== ROOMS.HOA_DON_BV) return;
    if (message.content.startsWith('!')) return;
    try {
      const row = parseBillEmbed(message);
      if (row) {
        this.queue.push(row);
        console.log(`📥 Đã gom Hóa đơn [CHƯA THANH TOÁN] của ${row[3]} vào Hàng Đợi.`);
      }
    } catch (e) {
      console.error('❌ Lỗi xử lý tin nhắn Hóa Đơn BV:', e.message);
    }
  }

  async updateHoaDonBV(ctx, fromStr, toStr) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);

    const now = nowVN();
    let fromDate, toDate;
    if (!fromStr) {
      fromDate = startOfDay(addMs(now, -7 * DAY_MS));
      toDate = endOfDay(now);
      await ctx.send(
        `⏳ Đang quét hóa đơn chưa thanh toán bệnh viện 7 ngày qua (**${fmt(fromDate, 'DD/MM/YYYY')}** → **${fmt(toDate, 'DD/MM/YYYY')}**, ghi đè dòng cũ)...`,
      );
    } else {
      fromDate = parseDMY(fromStr);
      const toDay = toStr ? parseDMY(toStr) : now;
      if (!fromDate || !toDay) {
        return ctx.send('⚠️ Cú pháp: `!updatehoadonbv [dd/mm/yyyy] [dd/mm/yyyy]`\nVí dụ: `!updatehoadonbv 01/06/2026 15/06/2026`');
      }
      toDate = endOfDay(toDay);
      await ctx.send(
        `⏳ Đang quét hóa đơn chưa thanh toán bệnh viện (**${fmt(fromDate, 'DD/MM/YYYY')}** → **${fmt(toDate, 'DD/MM/YYYY')}**)...`,
      );
    }

    try {
      const channel = this.bot.channels.cache.get(ROOMS.HOA_DON_BV);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh hóa đơn bệnh viện.');
      const sheet = await this.getSheet();
      const result = await backfillBills(channel, sheet, fromDate, toDate);
      await ctx.send(
        `✅ Cập nhật xong \`Hoa-Don-BV\`: ghi đè **${result.updated}** dòng, thêm mới **${result.appended}** dòng.`,
      );
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }
}
