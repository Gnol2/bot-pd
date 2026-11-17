import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, fmt, toVN, Mutex } from '../utils.js';

const ALLOWED = ['Giấy phép lái xe', 'Căn cước công dân'];

// Log cấp CCCD / GPLX -> sheet CCCDGPLX
export default class CCCDGPLX extends Cog {
  constructor(bot) {
    super(bot);
    this.writeLock = new Mutex(); // Xếp hàng ghi để không đè data của nhau
  }

  async sniperAppend(rowData) {
    const ws = this.bot.sheets.cccdgplx;
    const colA = await ws.colValues(1);
    const nextRow = colA.length + 1;
    await ws.updateCells(rowData.map((v, i) => cell(nextRow, i + 1, String(v))));
  }

  async onMessage(message) {
    if (message.channel.id !== ROOMS.GIAY_TO || !message.embeds.length) return;

    for (const embed of message.embeds) {
      if (!embed.title || !embed.title.includes('Tài liệu mới được tạo')) continue;

      let loai = '';
      let taoName = '', taoId = '';
      let nhanName = '', nhanId = '';
      let tenDayDu = '';

      for (const f of embed.fields ?? []) {
        const name = String(f.name).trim();
        const value = String(f.value).trim();
        if (name.includes('Loại tài liệu')) loai = value;
        else if (name.includes('Người tạo')) {
          const m = /^(.*?)\s*\(ID:\s*(\d+)\)/.exec(value);
          if (m) [taoName, taoId] = [m[1].trim(), m[2].trim()];
          else taoName = value;
        } else if (name.includes('Người nhận')) {
          const m = /^(.*?)\s*\(ID:\s*(\d+)\)/.exec(value);
          if (m) [nhanName, nhanId] = [m[1].trim(), m[2].trim()];
          else nhanName = value;
        } else if (name.includes('Tên đầy đủ')) tenDayDu = value;
      }

      if (!ALLOWED.includes(loai) || !tenDayDu) continue;

      const ngayTao = fmt(toVN(message.createdAt), 'DD/MM/YYYY HH:mm:ss');
      const rowData = [loai, ngayTao, taoName, taoId, nhanName, nhanId, tenDayDu];

      try {
        await this.writeLock.run(() => this.sniperAppend(rowData));
        console.log(`[CCCD-GPLX] Ghi ${loai}: ${tenDayDu}`);
      } catch (e) {
        console.error('[CCCD-GPLX] LỖI ghi sheet:', e.message);
      }
    }
  }
}
