import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { fmt, toVN, sanitizeRow } from '../utils.js';

// Ghi log bỏ tù / tạm giam -> sheet Tam-Giam
export default class LogTamGiam extends Cog {
  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.TAM_GIAM || !message.embeds.length) return;

    try {
      for (const embed of message.embeds) {
        let text = `${embed.title ?? ''}\n${embed.description ?? ''}\n`;
        for (const f of embed.fields ?? []) text += `${f.name}: ${f.value}\n`;
        const etc = text.replace(/\*/g, '').trim();
        const up = etc.toUpperCase();

        if (!up.includes('CẢNH SÁT BỎ TÙ') && !up.includes('TẠM GIAM')) continue;

        const ngayLap = "'" + fmt(toVN(message.createdAt), 'YYYY-MM-DD HH:mm:ss');

        const mOff = /Officer:\s*(.*?)\s*\(ID:\s*(\d+)\)/i.exec(etc);
        const mSus = /Suspect:\s*(.*?)\s*\(ID:\s*(\d+)\)/i.exec(etc);
        const mCid = /Citizen ID:\s*([A-Za-z0-9]+)/i.exec(etc);
        const mTime = /THỜI GIAN TÙ:\s*(\d+)/i.exec(etc);
        const mInc = /Incident ID:\s*#?(\d+)/i.exec(etc);

        if (mOff || mSus) {
          const row = [
            ngayLap,
            mOff ? mOff[2] : '',
            mOff ? mOff[1] : '',
            mSus ? mSus[2] : '',
            mSus ? mSus[1] : '',
            mCid ? mCid[1] : '',
            mTime ? mTime[1] : '',
            mInc ? mInc[1] : '',
          ];
          await this.bot.sheets.tamGiam.appendRow(sanitizeRow(row));
        }
      }
    } catch (e) {
      console.error('Lỗi ghi nhận Tạm Giam:', e.message);
    }
  }
}
