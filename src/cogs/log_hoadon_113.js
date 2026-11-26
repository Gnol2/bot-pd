import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import {
  S, at, cleanMoney, isDigits, money, nowVN, addMs, DAY_MS, startOfDay, weekday, fmt, vnToUtc,
  parseDMY, parseYMD, parseYMDHMS, callsignOf, history, processEmbedMessage, sanitizeRow,
} from '../utils.js';

// Hóa đơn VPGT/KTHC "Chưa thanh toán" -> sheet Hoa-Don-113; lệnh /quetdulieu và /hoadon (tính thưởng 113)
export default class LogHoaDon113 extends Cog {
  constructor(bot) {
    super(bot);
    this.queue = [];
    this.commands = {
      quetdulieu: (ctx) => this.quetDuLieu(ctx),
      hoadon: (ctx) => this.hoaDon(ctx),
    };
    this.loop('hd113_batch', 10_000, () => this.batchProcessor());
  }

  async batchProcessor() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 20);
    try {
      await this.bot.sheets.data.appendRows(batch);
      console.log(`[HoaDon113] Ghi ${batch.length} hóa đơn VPGT/KTHC vào sheet`);
    } catch (e) {
      console.error('[HoaDon113] LỖI ghi sheet:', e.message);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.HOA_DON) return;
    if (message.content.startsWith('!')) return;
    try {
      const rd = processEmbedMessage(message, true);
      if (rd) {
        const row = sanitizeRow(rd);
        this.queue.push(row);
        console.log(`[HoaDon113] Nhận hóa đơn ${row[1]}: $${row[6]}`);
      }
    } catch (e) {
      console.error('[HoaDon113] LỖI đọc tin nhắn:', e.message);
    }
  }

  // /quetdulieu [momo] DD/MM/YYYY-DD/MM/YYYY
  async quetDuLieu(ctx) {
    if (ctx.channel.id !== ROOMS.HOA_DON) return;

    const parts = ctx.message.content.trim().split(/\s+/);
    let targetId = null;
    let startStr = '', endStr = '';
    const clean = (s) => s.replace(/[[\]]/g, '');

    if (parts.length === 3 && parts[2].includes('-')) {
      targetId = clean(parts[1]);
      [startStr, endStr] = parts[2].split('-');
    } else if (parts.length === 2 && parts[1].includes('-')) {
      [startStr, endStr] = parts[1].split('-');
    } else if (parts.length === 4) {
      targetId = clean(parts[1]);
      [startStr, endStr] = [parts[2], parts[3]];
    } else if (parts.length === 3) {
      [startStr, endStr] = [parts[1], parts[2]];
    } else {
      return ctx.reply('⚠️ Cú pháp: `/quetdulieu [momo] <DD/MM/YYYY-DD/MM/YYYY>`\nVí dụ: `/quetdulieu 01/11/2026-07/11/2026`');
    }

    try {
      const parse = startStr?.includes('/') ? parseDMY : parseYMD;
      const startDate = parse(startStr);
      const endDay = parse(endStr);
      if (!startDate || !endDay) throw new Error(`không đọc được "${startStr}" / "${endStr}"`);
      const endDate = addMs(endDay, DAY_MS);

      await ctx.reply(`⏳ Đang quét lịch sử **${startStr}** → **${endStr}**...`);
      const sheetHoadon = [];
      const sheet113 = [];

      for await (const old of history(ctx.channel, { limit: null, after: vnToUtc(startDate), before: vnToUtc(endDate) })) {
        const row = processEmbedMessage(old, false);
        if (!row) continue;
        if (targetId && !String(row[2]).includes(targetId)) continue;
        sheetHoadon.push(sanitizeRow(row));
        const t = row[1].toUpperCase();
        if (t.includes('VPGT') || t.includes('KTHC')) sheet113.push(sanitizeRow(row));
      }

      if (sheet113.length) await this.bot.sheets.data.appendRows(sheet113);
      if (sheetHoadon.length) await this.bot.sheets.hoadon.appendRows(sheetHoadon);

      await ctx.reply(`✅ Quét xong: **${sheet113.length}** dòng vào \`Hoa-Don-113\`, **${sheetHoadon.length}** dòng vào \`Hoa-Don\`.`);
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }

  // /hoadon hoặc /hoadon DD/MM-DD/MM
  async hoaDon(ctx) {
    if (ctx.channel.id !== ROOMS.KPI) return;

    const authorName = ctx.author.displayName;
    const callsign = callsignOf(authorName);

    const teamData = await this.bot.sheets.team.getAllValues();
    let momoId = null, tenSiQuan = null;
    for (const row of teamData) {
      if (row.length >= 4 && S(row[1]) === callsign) {
        momoId = S(row[2]);
        tenSiQuan = S(row[3]);
        break;
      }
    }
    if (!momoId) return ctx.reply(`❌ **${authorName}** không có trong danh sách Đội 113.`);

    const parts = ctx.message.content.trim().split(/\s+/);
    const year = nowVN().getUTCFullYear();
    let startDate, endFull;
    if (parts.length === 1) {
      const today = nowVN();
      startDate = startOfDay(addMs(today, -weekday(today) * DAY_MS));
      endFull = addMs(startDate, 7 * DAY_MS - 1000);
    } else if (parts.length === 2) {
      const [s, e] = parts[1].split('-');
      const sd = parseDMY(`${s}/${year}`);
      const ed = parseDMY(`${e}/${year}`);
      if (!sd || !ed) return ctx.reply('❌ Ngày không hợp lệ. Dùng `DD/MM-DD/MM`.');
      startDate = sd;
      endFull = addMs(ed, DAY_MS - 1000);
    } else {
      return ctx.reply('⚠️ Cú pháp: `/hoadon [DD/MM-DD/MM]`');
    }

    try {
      await ctx.reply(`⏳ Đang tính hóa đơn của **${tenSiQuan}** (chỉ tính HĐ > $1,500)...`);
      const allRows = await this.bot.sheets.data.getAllValues();
      let count = 0;
      let total = 0;

      for (const row of allRows.slice(1)) {
        if (row.length >= 8 && S(row[2]) === momoId && S(at(row, 7)).includes('Chưa thanh toán')) {
          const d = parseYMDHMS(String(row[0]).replace(/'/g, ''));
          if (d && d >= startDate && d <= endFull) {
            const m = cleanMoney(row[6]);
            if (isDigits(m) && parseInt(m, 10) > 1500) {
              count++;
              total += parseInt(m, 10);
            }
          }
        }
      }

      const tienGoc = total > 0 ? Math.trunc(total / 1.05) : 0;
      const bonus = count >= 15 ? `**$${money(Math.round(tienGoc * 0.15))}**` : 'Không (chưa đủ 15 HĐ > $1,500)';

      await ctx.reply(
        `ℹ️ Hóa đơn 113: **${tenSiQuan}** | ID: **${momoId}**\n` +
          `Thời gian: **${fmt(startDate, 'DD/MM')} → ${fmt(endFull, 'DD/MM')}**\n` +
          `HĐ hợp lệ (> $1,500): **${count}**\n` +
          `Tổng tiền: **$${money(tienGoc)}**\n` +
          `Thưởng (15%): ${bonus}`,
      );
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }
}
