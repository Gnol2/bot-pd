import { Cog } from '../core/Cog.js';
import { ROOMS, SHEET_IDS, alertRoom } from '../config.js';
import { S, fmt, toVN, vnToUtc, parseDMY, addMs, hasRole, history, isBotAdmin, NO_PERM } from '../utils.js';

const COP_RE = /Cảnh sát:\s*(.*?)\s*\(\s*ID:\s*(\d+)\s*\)/i;
const TARGET_RE = /Đã còng:\s*(.*?)\s*\(\s*ID:\s*(\d+)\s*\)/i;

// Giám sát còng tay: người không phải cảnh sát / cảnh sát OFF DUTY dùng còng -> báo phòng vi phạm
export default class LogHandcuff extends Cog {
  constructor(bot) {
    super(bot);
    this.cacheOnline = [];
    this.lastCacheUpdate = 0;
    this.commands = { congtay: (ctx, copId, range) => this.congtay(ctx, copId, range) };
  }

  extractEmbedText(embed) {
    const parts = [];
    if (embed.title) parts.push(String(embed.title));
    if (embed.description) parts.push(String(embed.description));
    if (embed.author?.name) parts.push(String(embed.author.name));
    for (const f of embed.fields ?? []) {
      if (f.name) parts.push(String(f.name));
      if (f.value) parts.push(String(f.value));
    }
    return parts.join('\n').replace(/[*`]/g, '').trim();
  }

  // Cache sheet Online 5 phút để không spam Google API
  async getCachedOnline() {
    if (Date.now() - this.lastCacheUpdate > 300_000) {
      try {
        this.cacheOnline = await this.bot.sheets.online.getAllValues();
        this.lastCacheUpdate = Date.now();
      } catch (e) {
        console.error('[CongTay] LỖI tải lại Online:', e.message);
      }
    }
    return this.cacheOnline;
  }

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.HANDCUFF || !message.embeds.length) return;

    try {
      for (const embed of message.embeds) {
        const etc = this.extractEmbedText(embed);
        if (!etc.includes('Còng tay') && !etc.includes('Hard Cuff')) continue;

        const mCop = COP_RE.exec(etc);
        const mTarget = TARGET_RE.exec(etc);
        if (!mCop || !mTarget) continue;

        const copName = mCop[1].trim();
        const copId = mCop[2].trim();
        const targetName = mTarget[1].trim();
        const targetId = mTarget[2].trim();

        const online = await this.getCachedOnline();
        let copRow = null;
        let targetRow = null;
        for (let idx = 1; idx < online.length; idx++) {
          const row = online[idx];
          if (row.length >= 9) {
            const momo = S(row[2]);
            if (momo === copId) copRow = row;
            if (momo === targetId) targetRow = row;
          }
        }

        const infoY = targetRow
          ? `Cảnh sát **${targetRow[1]} | ${targetId} | ${targetRow[3]}**`
          : `Người dân **${targetName} | ${targetId}**`;

        if (!copRow) {
          const alert = this.bot.channels.cache.get(alertRoom('VP_CONG_NGOAI'));
          if (alert) {
            await alert.send(
              `🚨 **NGƯỜI NGOÀI PD DÙNG CÒNG TAY**\n` +
                `Người còng: **${copName} | ${copId}** (không có trong danh sách PD)\n` +
                `Bị còng: ${infoY}`,
            );
          }
          continue;
        }

        const copDuty = S(copRow[7]);
        if (copDuty === '') {
          const alert = this.bot.channels.cache.get(alertRoom('VP_CONG_OFFDUTY'));
          if (alert) {
            await alert.send(
              `🚨 **CÒNG TAY KHI OFF DUTY**\n` +
                `Cảnh sát: **${copRow[1]} | ${copId} | ${copRow[3]}** (OFF DUTY)\n` +
                `Bị còng: ${infoY}`,
            );
          }
        }
      }
    } catch (e) {
      console.error('[CongTay] LỖI kiểm tra còng tay:', e.message);
    }
  }

  // !congtay <ID> dd/mm-dd/mm
  async congtay(ctx, copId, dateRange) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    if (!copId || !dateRange || !dateRange.includes('-')) {
      return ctx.send('⚠️ Cú pháp: `!congtay <ID> <DD/MM-DD/MM>`\nVí dụ: `!congtay 12345 01/11-07/11`');
    }

    const [startStr, endStr] = dateRange.split('-');
    const year = new Date().getFullYear();
    const startDt = parseDMY(`${startStr}/${year}`);
    const endDay = parseDMY(`${endStr}/${year}`);
    if (!startDt || !endDay) return ctx.send('❌ Ngày không hợp lệ. Dùng `DD/MM-DD/MM`.');
    const endDt = addMs(endDay, (23 * 3600 + 59 * 60 + 59) * 1000);

    const loading = await ctx.send(`⏳ Đang quét còng tay của ID **${copId}** (**${startStr}** → **${endStr}**)...`);
    const channel = this.bot.channels.cache.get(ROOMS.HANDCUFF);
    if (!channel) return loading.edit('❌ Không tìm thấy kênh log còng tay.');

    const records = [];
    let count = 0;
    try {
      for await (const msg of history(channel, { limit: null, after: vnToUtc(startDt), before: vnToUtc(endDt) })) {
        count++;
        for (const embed of msg.embeds) {
          const etc = this.extractEmbedText(embed);
          if (!etc.includes('Còng tay') && !etc.includes('Hard Cuff')) continue;
          const mCop = COP_RE.exec(etc);
          const mTarget = TARGET_RE.exec(etc);
          if (mCop && mTarget && mCop[2].trim() === copId) {
            records.push([fmt(toVN(msg.createdAt), 'DD/MM/YYYY HH:mm:ss'), mCop[2].trim(), mTarget[2].trim()]);
          }
        }
        if (count % 5000 === 0) {
          await loading
            .edit(`⏳ Đang quét... **${count.toLocaleString('en-US')}** tin nhắn, **${records.length}** kết quả`)
            .catch(() => {});
        }
      }

      if (!records.length) {
        return loading.edit(`📭 Không có lần còng tay nào của ID **${copId}**.`);
      }

      const ws = await this.bot.gs.worksheet(SHEET_IDS.MAIN, 'Cong-Tay');
      await ws.appendRows(records);
      await loading.edit(`✅ Đã ghi **${records.length}** dòng vào \`Cong-Tay\`.`);
    } catch (e) {
      await loading.edit(`❌ Lỗi: ${e.message}`);
    }
  }
}
