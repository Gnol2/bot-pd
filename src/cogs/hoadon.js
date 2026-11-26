import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, hasRole, history, nowVN, addMs, DAY_MS, startOfDay, endOfDay, parseDMY, fmt, vnToUtc, parseBillEmbed, isBotAdmin, NO_PERM } from '../utils.js';

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
      console.log(`[HoaDon] Ghi ${batch.length} hóa đơn chưa thanh toán vào sheet`);
    } catch (e) {
      console.error('[HoaDon] LỖI ghi sheet:', e.message);
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
        console.log(`[HoaDon] Nhận hóa đơn chưa thanh toán: ${row[3]}`);
      }
    } catch (e) {
      console.error('[HoaDon] LỖI đọc tin nhắn:', e.message);
    }
  }

  // /updatehoadon [dd/mm/yyyy] [dd/mm/yyyy]
  async updateHoaDon(ctx, fromStr, toStr) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);

    const now = nowVN();
    let fromDate, toDate;
    if (!fromStr) {
      fromDate = startOfDay(addMs(now, -7 * DAY_MS));
      toDate = endOfDay(now);
      await ctx.send(
        `⏳ Đang quét hóa đơn chưa thanh toán GCPD 7 ngày qua (**${fmt(fromDate, 'DD/MM/YYYY')}** → **${fmt(toDate, 'DD/MM/YYYY')}**, ghi đè dòng cũ)...`,
      );
    } else {
      fromDate = parseDMY(fromStr);
      const toDay = toStr ? parseDMY(toStr) : now;
      if (!fromDate || !toDay) {
        return ctx.send('⚠️ Cú pháp: `/updatehoadon [dd/mm/yyyy] [dd/mm/yyyy]`\nVí dụ: `/updatehoadon 01/07/2026 15/07/2026`');
      }
      toDate = endOfDay(toDay);
      await ctx.send(
        `⏳ Đang quét hóa đơn chưa thanh toán GCPD (**${fmt(fromDate, 'DD/MM/YYYY')}** → **${fmt(toDate, 'DD/MM/YYYY')}**)...`,
      );
    }

    try {
      const channel = this.bot.channels.cache.get(ROOMS.HOA_DON);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh hóa đơn GCPD.');
      const sheet = this.bot.sheets.hoadon;
      const result = await backfillBills(channel, sheet, fromDate, toDate);
      await ctx.send(
        `✅ Cập nhật xong \`Hoa-Don\`: ghi đè **${result.updated}** dòng, thêm mới **${result.appended}** dòng.`,
      );
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
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
