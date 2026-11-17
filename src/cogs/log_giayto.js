import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, fmt, toVN, sanitizeVal, Mutex } from '../utils.js';

// Ghi log Property Deed -> sheet Giay-To
export default class LogGiayTo extends Cog {
  constructor(bot) {
    super(bot);
    // Bản Python gọi gspread đồng bộ nên tự xếp hàng; bản JS cần khoá để 2 log cùng lúc không ghi đè cùng 1 dòng
    this.lock = new Mutex();
  }

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.GIAY_TO || !message.embeds.length) return;

    try {
      for (const embed of message.embeds) {
        let ltl = '', nt = '', tdd = '', dc = '';
        for (const f of embed.fields ?? []) {
          const n = String(f.name).toLowerCase();
          const v = String(f.value).replace(/\*/g, '').trim();
          if (n.includes('loại tài liệu')) ltl = v;
          else if (n.includes('người tạo')) nt = v;
          else if (n.includes('tên đầy đủ')) tdd = v;
          else if (n.includes('địa chỉ')) dc = v;
        }

        if (!ltl.includes('Property Deed')) continue;

        const nL = "'" + fmt(toVN(message.createdAt), 'YYYY-MM-DD HH:mm:ss');

        const mT = /(.*?)\s*\(ID:\s*(\d+)\)/i.exec(nt);
        const ntn = mT ? mT[1].trim() : nt;
        const ntid = mT ? mT[2].trim() : '';

        const mN = /^(.*?)\s+(\d+)$/.exec(tdd);
        const nnn = mN ? mN[1].trim() : tdd;
        const nnid = mN ? mN[2].trim() : '';

        const rowData = [ltl, nL, ntn, ntid, nnn, nnid, tdd, dc, 0, 0];

        await this.lock.run(async () => {
          const ws = this.bot.sheets.giayTo;
          const colA = await ws.colValues(1);
          const nextRow = colA.length + 1;
          await ws.updateCells(rowData.map((v, i) => cell(nextRow, i + 1, sanitizeVal(v))));
        });
      }
    } catch (e) {
      console.error('[GiayTo] LỖI ghi Property Deed:', e.message);
    }
  }
}
