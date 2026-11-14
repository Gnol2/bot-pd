import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, hasRole, history, nowVN, addMs, DAY_MS, startOfDay, endOfDay, parseDMY, fmt, vnToUtc, parseBillEmbed } from '../utils.js';

// Hóa đơn PD "Chưa thanh toán" -> sheet Hoa-Don (gom 10 giây / chuyến)
export default class HoaDon extends Cog {
  constructor(bot) {
    super(bot);
    this.queue = [];
    this.commands = { updatehoadon: (ctx, a, b) => this.updateHoaDon(ctx, a, b) };
    this.loop('hoadon_batch', 10_000, () => this.batchProcessor());
  }

  async batchProcessor() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 20);
    try {
      await this.bot.sheets.hoadon.appendRows(batch);
      console.log(`🚀 [Bus HoaDon] Đã chở sỉ ${batch.length} Hóa đơn [CHƯA THANH TOÁN] lên Sheet an toàn!`);
    } catch (e) {
      console.error('❌ Lỗi chuyến xe buýt Hóa Đơn Cảnh Sát:', e.message);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message) || !message.embeds.length) return;
    if (message.channel.id !== ROOMS.HOA_DON) return;
    if (message.content.startsWith('!')) return;
    try {
      const row = parseBillEmbed(message);
      if (row) {
        this.queue.push(row);
        console.log(`📥 Đã gom Hóa đơn [CHƯA THANH TOÁN] của ${row[3]} vào Hàng Đợi GCPD.`);
      }
    } catch (e) {
      console.error('❌ Lỗi xử lý tin nhắn Hóa Đơn GCPD:', e.message);
    }
  }

  // !updatehoadon [dd/mm/yyyy] [dd/mm/yyyy]
  async updateHoaDon(ctx, fromStr, toStr) {
    if (!hasRole(ctx.author, 'Hội Đồng Ủy Ban')) return ctx.send('❌ KHÔNG CÓ THẨM QUYỀN!');

    const now = nowVN();
    let fromDate, toDate;
    if (!fromStr) {
      fromDate = startOfDay(addMs(now, -7 * DAY_MS));
      toDate = endOfDay(now);
      await ctx.send(
        `⏳ **Radar đang rà soát Hóa đơn [Chưa thanh toán] GCPD trong vòng 1 tuần qua...**\n*(Mốc: Từ ${fmt(fromDate, 'DD/MM/YYYY')} đến ${fmt(toDate, 'DD/MM/YYYY')} - Chế độ ghi đè đã bật)*`,
      );
    } else {
      fromDate = parseDMY(fromStr);
      const toDay = toStr ? parseDMY(toStr) : now;
      if (!fromDate || !toDay) {
        return ctx.send('❌ **Sai định dạng!** Vui lòng nhập chuẩn: `dd/mm/yyyy` (Ví dụ: `!updatehoadon 01/07/2026 15/07/2026`).');
      }
      toDate = endOfDay(toDay);
      await ctx.send(
        `⏳ **Radar khởi động chiến dịch Backfill Hóa đơn [Chưa thanh toán] GCPD...**\n*(Mốc: Từ ${fmt(fromDate, 'DD/MM/YYYY')} đến ${fmt(toDate, 'DD/MM/YYYY')} - Đang chuẩn bị nạp dữ liệu)*`,
      );
    }

    try {
      const channel = this.bot.channels.cache.get(ROOMS.HOA_DON);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh Hóa Đơn GCPD!');
      const sheet = this.bot.sheets.hoadon;
      const result = await backfillBills(channel, sheet, fromDate, toDate);
      await ctx.send(
        `✅ **CHIẾN DỊCH HOÀN THÀNH XUẤT SẮC!**\n🔹 Đã đồng bộ/ghi đè: **${result.updated}** hóa đơn [Chưa thanh toán] cũ.\n🔹 Đã bổ sung (Ghi bù): **${result.appended}** hóa đơn [Chưa thanh toán] mới vào Sheet GCPD!`,
      );
    } catch (e) {
      await ctx.send(`❌ Lỗi chiến dịch càn quét GCPD: ${e.message}`);
    }
  }
}

// Dùng chung cho hoadon và hoadonbv: quét lịch sử kênh, ghi đè dòng đã có (khớp thời gian + id gửi + id nhận), ghi bù dòng thiếu
export async function backfillBills(channel, sheet, fromDate, toDate) {
  const allRows = await sheet.getAllValues();
  const sigOf = (r) => `${String(r[0]).trim()}_${String(r[2]).trim()}_${String(r[4]).trim()}`;

  const sigToRow = new Map();
  allRows.forEach((row, idx) => {
    if (row.length > 4) sigToRow.set(sigOf(row), idx + 1);
  });

  const missing = [];
  const cells = [];
  const processed = new Set();

  for await (const message of history(channel, { limit: null, after: vnToUtc(fromDate), before: vnToUtc(toDate) })) {
    if (message.content.startsWith('!') || !message.embeds.length) continue;
    const row = parseBillEmbed(message);
    if (!row) continue;
    const sig = sigOf(row);
    if (processed.has(sig)) continue;
    processed.add(sig);
    if (sigToRow.has(sig)) {
      const r = sigToRow.get(sig);
      row.forEach((v, i) => cells.push(cell(r, i + 1, v)));
    } else {
      missing.push(row);
    }
  }

  if (cells.length) await sheet.updateCells(cells);
  if (missing.length) {
    missing.reverse();
    await sheet.appendRows(missing);
  }
  return { updated: processed.size - missing.length, appended: missing.length };
}
