import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { S, cell, nowVN, parseYMDHMS, cleanMoney, isDigits, roleByName, isGplmbName } from '../utils.js';

// Mỗi 3 phút: cấp GPLMB phải có hóa đơn >= $50,000 trong ±10 phút, không có thì báo Đội Bay
export default class CheckerGPLMBBill extends Cog {
  constructor(bot) {
    super(bot);
    this.loop('check_gplmb_loop', 3 * 60_000, () => this.check());
  }

  // Tìm Discord member theo momo: sĩ quan chính thức dò theo callsign, học viên dò theo "HV" + tên
  resolveOfficerByMomo(momoVal, momoDict, guild) {
    const momo = S(momoVal);
    if (!momo) return [null, null];
    const data = momoDict.get(momo);
    if (!data) return [momo, null];
    const { callsign, name } = data;

    if (guild) {
      for (const m of guild.members.cache.values()) {
        const disp = m.displayName;
        const low = disp.toLowerCase();
        if (callsign && disp.startsWith(String(callsign))) return [momo, m.id];
        if (!callsign && name && low.includes('hv') && low.includes(name.toLowerCase())) return [momo, m.id];
      }
    }
    return [momo, null];
  }

  // Đọc và đánh dấu "Đã Check" theo số hàng -> giữ khoá chung để log_giayto không xoá hàng xen giữa
  check() {
    return this.bot.giayToLock.run(() => this.checkLocked());
  }

  async checkLocked() {
    try {
      const gtRows = await this.bot.sheets.giayTo.getAllValues();
      const hdRows = await this.bot.sheets.hoadon.getAllValues();

      let roleRows = [];
      try {
        roleRows = await this.bot.sheets.role.getAllValues();
      } catch (e) {
        console.error('[KiemTraGPLMB] LỖI đọc GCPD HOME:', e.message);
      }

      const momoDict = new Map();
      for (const r of roleRows) {
        if (r.length >= 4) {
          const m = S(r[2]);
          if (m) momoDict.set(m, { callsign: S(r[1]), name: S(r[3]) });
        }
      }

      const startGt = Math.max(1, gtRows.length - 50);
      const rowsToCheck = gtRows.slice(startGt);
      const recentHd = hdRows.slice(Math.max(1, hdRows.length - 100));

      const cells = [];
      const doiBay = this.bot.channels.cache.get(ROOMS.DOI_BAY);
      if (!doiBay) return;
      const guild = doiBay.guild;
      const now = nowVN();
      const roleAs = roleByName(guild, 'Air Squadron 51th');
      const roleMentionStr = roleAs ? roleAs.toString() : '**@Air Squadron 51th**';

      for (let i = 0; i < rowsToCheck.length; i++) {
        const row = rowsToCheck[i];
        const actualRow = startGt + i + 1;

        const nguoiLap = row.length > 2 ? S(row[2]) : '';
        if (nguoiLap === 'Hệ Thống') continue;

        const tenGp = row.length > 7 ? S(row[7]) : '';
        if (!isGplmbName(tenGp)) continue;

        const daCheck = row.length > 11 ? S(row[11]) : '';
        if (daCheck === 'Đã Check') continue;

        const ngayCap = S(String(row[1]).replace(/'/g, ''));
        const tg = parseYMDHMS(ngayCap);
        if (!tg) continue;

        const diffMin = (now - tg) / 60000;
        if (diffMin < 10 || diffMin > 1440) continue;

        const momoLap = row.length > 3 ? S(row[3]) : '';
        const tenNhan = row.length > 4 ? S(row[4]) : 'Không rõ';
        const momoNhan = row.length > 5 ? S(row[5]) : '';

        if (momoLap && momoNhan) {
          let found = false;
          for (const hd of recentHd) {
            if (hd.length < 7) continue;
            if (S(hd[2]) !== momoLap || S(hd[4]) !== momoNhan) continue;
            const hdTime = parseYMDHMS(S(String(hd[0]).replace(/'/g, '')));
            if (!hdTime || Math.abs(hdTime - tg) / 1000 > 600) continue;
            const tien = cleanMoney(hd[6]);
            if (isDigits(tien) && parseInt(tien, 10) >= 50000) {
              found = true;
              break;
            }
          }

          if (!found) {
            const [, uidLap] = this.resolveOfficerByMomo(momoLap, momoDict, guild);
            const officer = uidLap ? `<@${uidLap}> (Momo: **${momoLap}**)` : `(Momo: **${momoLap}**)`;
            const [, uidNhan] = this.resolveOfficerByMomo(momoNhan, momoDict, guild);
            const target = uidNhan ? `<@${uidNhan}> (Momo: **${momoNhan}**)` : `**${tenNhan}** (Momo: **${momoNhan}**)`;

            await doiBay.send(
              `🚨 **CẤP GPLMB THIẾU HÓA ĐƠN** ${roleMentionStr}\n` +
                `Cảnh sát: ${officer}\n` +
                `Đối tượng: ${target}\n` +
                `Thời gian: **${ngayCap}**\n` +
                `Lý do: cấp \`${tenGp}\` nhưng không có hóa đơn **$50,000** trong ±10 phút. Yêu cầu xuất trình hóa đơn.`,
            );
          }
        }

        // Đánh dấu cột L
        cells.push(cell(actualRow, 12, 'Đã Check'));
      }

      if (cells.length) await this.bot.sheets.giayTo.updateCells(cells);
    } catch (e) {
      console.error('[KiemTraGPLMB] LỖI chu kỳ kiểm tra:', e.message);
    }
  }
}
