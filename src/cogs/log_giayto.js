import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { S, at, cell, fmt, toVN, sanitizeVal, isGplmbName } from '../utils.js';

// Ghi log Property Deed -> sheet Giay-To.
// GPLMB mới: xoá mọi GPLMB cũ của cùng momo người nhận (kể cả bằng đã tịch thu, dòng cũ để trống tên giấy phép),
// bằng mới tính lại từ 0 vi phạm.
export default class LogGiayTo extends Cog {
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

        await this.bot.giayToLock.run(async () => {
          const ws = this.bot.sheets.giayTo;
          const all = await ws.getAllValues();

          // GPLMB cũ của cùng momo người nhận (tìm trước khi ghi bằng mới)
          const oldRows = [];
          if (nnid && isGplmbName(dc)) {
            for (let i = 1; i < all.length; i++) {
              const r = all[i];
              const loai = S(at(r, 0));
              if (!loai.includes('Property Deed') && !loai.includes('GPLMB')) continue;
              if (S(at(r, 5)) === nnid && isGplmbName(at(r, 7), { allowEmpty: true })) oldRows.push(i + 1);
            }
          }

          // Ghi bằng mới trước, xoá bằng cũ sau: lỗi khi xoá thì vẫn không mất log bằng mới
          const colA = await ws.colValues(1);
          const nextRow = colA.length + 1;
          await ws.updateCells(rowData.map((v, i) => cell(nextRow, i + 1, sanitizeVal(v))));

          if (oldRows.length) {
            await ws.deleteRows(oldRows);
            console.log(`[GiayTo] GPLMB mới của momo ${nnid}: đã xoá ${oldRows.length} GPLMB cũ (hàng ${oldRows.join(', ')})`);
            // Báo gplmb: số hàng đã dồn lên (bỏ cache) + tắt nhắc tịch thu bằng cũ của momo này
            this.bot.emit('giayToRowsDeleted', { momo: nnid });
          }
        });
      }
    } catch (e) {
      console.error('[GiayTo] LỖI ghi Property Deed:', e.message);
    }
  }
}
