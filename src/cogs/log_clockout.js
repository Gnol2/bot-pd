import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell } from '../utils.js';

// MDT Clock-Out (Off Duty) -> xoá trắng cột H (Duty) và I (Radio) của sheet Online, dò theo tên
export default class LogClockout extends Cog {
  normalizeName(name) {
    if (!name) return '';
    let n = String(name).trim().replace(/^[ .,]+|[ .,]+$/g, '');
    n = n.split(/\s+/).filter(Boolean).join(' ');
    return n.toLowerCase();
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

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.CLOCKOUT || !message.embeds.length) return;

    try {
      for (const embed of message.embeds) {
        const etc = this.extractEmbedText(embed);
        if (!etc.includes('MDT Clock-Out') || !etc.includes('Off Duty')) continue;

        const mName = /Tên:\s*([^\n]+)/i.exec(etc);
        if (!mName) continue;

        const rawName = mName[1];
        const targetName = this.normalizeName(rawName);
        if (!targetName) continue;

        const ws = this.bot.sheets.online;
        const allRows = await ws.getAllValues();
        let foundIdx = -1;
        for (let idx = 0; idx < allRows.length; idx++) {
          const row = allRows[idx];
          if (row.length >= 4 && this.normalizeName(row[3]) === targetName) {
            foundIdx = idx + 1;
            break;
          }
        }

        if (foundIdx !== -1) {
          await ws.updateCells([cell(foundIdx, 8, ' '), cell(foundIdx, 9, ' ')]);
          const tenTrongSheet = String(allRows[foundIdx - 1][3]).trim();
          console.log(`🚨 [CLOCK-OUT] Đã dọn dẹp (Xóa H & I) cho Sĩ quan: Discord '${rawName.trim()}' <-> Sheet '${tenTrongSheet}'`);
        }
      }
    } catch (e) {
      console.error('Lỗi chấm công Clockout:', e.message);
    }
  }
}
