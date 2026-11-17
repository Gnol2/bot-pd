import { Cog } from '../core/Cog.js';
import { S, cell, cleanMoney, isDigits, nowVN, parseYMDHMS, parseDMYHMS } from '../utils.js';

const parseAny = (s) => parseYMDHMS(s) ?? parseDMYHMS(s);

// Mỗi 2 phút: ghép hóa đơn CCCD/GPLX (Hoa-Don) với giấy tờ đã cấp (CCCDGPLX) và ghi số tiền vào cột H
export default class CheckGiayTo extends Cog {
  constructor(bot) {
    super(bot);
    this.loop('check_hoadon_loop', 2 * 60_000, () => this.check());
  }

  async check() {
    try {
      const hdData = await this.bot.sheets.hoadon.getAllValues();
      const cgData = await this.bot.sheets.cccdgplx.getAllValues();
      if (!hdData.length || !cgData.length) return;

      const hdRecent = hdData.length > 50 ? hdData.slice(-50) : hdData.slice(1);
      const cells = [];
      const now = nowVN();

      for (const hd of hdRecent) {
        if (hd.length < 7) continue;

        const loaiHd = S(hd[1]).toUpperCase();
        const hasCccd = loaiHd.includes('CCCD');
        const hasGplx = loaiHd.includes('GPLX');
        if (!hasCccd && !hasGplx) continue;

        const tgHdStr = S(String(hd[0]).replace(/'/g, ''));
        const momoTao = S(hd[2]);
        const momoNhan = S(hd[4]);

        const tienRaw = cleanMoney(hd[6]);
        const tien = isDigits(tienRaw) ? parseInt(tienRaw, 10) : 0;

        let tienGhi;
        let targets;
        if (hasCccd && hasGplx) {
          tienGhi = tien === 1 ? '1' : String(Math.floor(tien / 2)); // Combo: chia đôi
          targets = ['Căn cước công dân', 'Giấy phép lái xe'];
        } else if (hasCccd) {
          tienGhi = String(tien);
          targets = ['Căn cước công dân'];
        } else {
          tienGhi = String(tien);
          targets = ['Giấy phép lái xe'];
        }

        const tgHd = parseAny(tgHdStr);
        if (!tgHd) continue;
        if ((now - tgHd) / 1000 > 1800) continue; // Hóa đơn quá 30 phút

        // Dò ngược từ dưới lên trong CCCDGPLX
        const body = cgData.slice(1);
        for (let i = 0; i < body.length; i++) {
          const cg = body[body.length - 1 - i];
          const actualIdx = cgData.length - i;
          if (cg.length < 6) continue;

          const daGhi = cg.length > 7 ? S(cg[7]) : '';
          if (daGhi) continue;

          const loaiCg = S(cg[0]);
          if (!targets.includes(loaiCg)) continue;

          if (momoTao !== S(cg[3]) || momoNhan !== S(cg[5])) continue;

          const tgCg = parseDMYHMS(S(cg[1])) ?? parseYMDHMS(S(cg[1]));
          if (!tgCg) continue;

          if (Math.abs(tgHd - tgCg) / 60000 <= 10) {
            cells.push(cell(actualIdx, 8, tienGhi));
            targets.splice(targets.indexOf(loaiCg), 1);
            if (!targets.length) break;
          }
        }
      }

      if (cells.length) {
        await this.bot.sheets.cccdgplx.updateCells(cells);
        console.log(`[GiayTo] Chuyển ${cells.length} ô phí giấy tờ (gồm combo) sang CCCDGPLX`);
      }
    } catch (e) {
      console.error('[GiayTo] LỖI chu kỳ kiểm tra:', e.message);
    }
  }
}
