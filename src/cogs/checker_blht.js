import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { S, cell, nowVN, vnToUtc, addMs, parseYMDHMS, money, escapeRe, roleByName, layIdTheoCallsign, history, COLORS, uniq } from '../utils.js';

const SKIP_STATES = ['Đã Check', 'Bỏ qua', 'Bỏ qua (Nhân bản)'];
const parseInvoices = (raw) =>
  String(raw)
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter((d) => /^\d+$/.test(d))
    .map((d) => parseInt(d, 10));

// Mỗi 3 phút: kiểm tra MDT "BLHT" (mức phạt và dấu !vipham), sai thì lập biên bản ở phòng Đội Bay
export default class CheckerBLHT extends Cog {
  constructor(bot) {
    super(bot);
    this.loop('check_blht_loop', 3 * 60_000, () => this.check());
  }

  resolveOfficerByMomo(momoVal, momoToCs, guild) {
    const momo = S(momoVal);
    if (!momo) return [null, null];
    const cs = momoToCs.get(momo);
    const uid = cs && guild ? layIdTheoCallsign(guild, cs) : null;
    return [momo, uid];
  }

  async check() {
    try {
      const allRows = await this.bot.sheets.incident.getAllValues();
      if (!allRows.length) return;

      let roleRows = [];
      try {
        roleRows = await this.bot.sheets.role.getAllValues();
      } catch {
        /* bỏ qua */
      }
      const momoToCs = new Map();
      for (const r of roleRows) {
        if (r.length >= 3) {
          const c = S(r[1]);
          const m = S(r[2]);
          if (c && m) momoToCs.set(m, c);
        }
      }

      const startIdx = Math.max(1, allRows.length - 30);
      const rowsToCheck = allRows.slice(startIdx);
      const cells = [];

      const doiBay = this.bot.channels.cache.get(ROOMS.DOI_BAY);
      const gplmbCh = this.bot.channels.cache.get(ROOMS.GPLMB_CMD);
      if (!doiBay || !gplmbCh) return;

      const guild = doiBay.guild;
      const now = nowVN();
      const roleAs = roleByName(guild, 'Air Squadron 51th');
      const roleMentionStr = roleAs ? roleAs.toString() : '**@Air Squadron 51th**';

      for (let i = 0; i < rowsToCheck.length; i++) {
        const row = rowsToCheck[i];
        const actualRow = startIdx + i + 1;
        const tenVuAn = row.length > 2 ? S(row[2]).toUpperCase() : '';
        if (!tenVuAn.includes('BLHT')) continue;

        const daCheck = row.length > 14 ? S(row[14]) : '';
        if (SKIP_STATES.includes(daCheck)) continue;

        const tgStr = S(String(row[0]).replace(/'/g, ''));
        const idMdt = row.length > 1 ? S(row[1]) : 'Không rõ';
        const tg = parseYMDHMS(tgStr);
        if (!tg) continue;

        const diffMin = (now - tg) / 60000;
        if (diffMin < 15 || diffMin > 1440) continue;

        const hoaDonRaw = row.length > 12 ? S(row[12]) : '';
        const momoTpRaw = row.length > 10 ? S(row[10]) : '';
        const momoLapRaw = row.length > 4 ? S(row[4]) : '';
        const momosLqRaw = row.length > 5 ? S(row[5]) : '';

        const targets = momoTpRaw
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m && !['0', '-', 'none', 'null'].includes(m));

        if (!targets.length) {
          cells.push(cell(actualRow, 15, 'Bỏ qua'));
          continue;
        }

        const invoices = parseInvoices(hoaDonRaw);

        // Phát hiện MDT nhân bản (cùng người lập, cùng đối tượng, lệch <= 60s): chỉ giữ bản có tổng tiền cao nhất
        if (momoLapRaw) {
          const siblings = [];
          const searchSpace = allRows.slice(-50);
          const offset = allRows.length - searchSpace.length;
          searchSpace.forEach((cr, ci) => {
            const ctg = parseYMDHMS(S(String(cr[0]).replace(/'/g, '')));
            if (!ctg || Math.abs(tg - ctg) / 1000 > 60) return;
            const cLap = cr.length > 4 ? S(cr[4]) : '';
            const cTargets = (cr.length > 10 ? S(cr[10]) : '').split(',').map((m) => m.trim()).filter(Boolean);
            if (cLap === momoLapRaw && targets.some((t) => cTargets.includes(t))) {
              const total = parseInvoices(cr.length > 12 ? S(cr[12]) : '').reduce((a, b) => a + b, 0);
              siblings.push({ absIdx: offset + ci, time: ctg, total });
            }
          });
          if (siblings.length > 1) {
            siblings.sort((a, b) => b.total - a.total || a.time - b.time || a.absIdx - b.absIdx);
            if (startIdx + i !== siblings[0].absIdx) {
              cells.push(cell(actualRow, 15, 'Bỏ qua (Nhân bản)'));
              continue;
            }
          }
        }

        let isRowValid = false;
        let lyDo = '';

        if (!invoices.length || !momoLapRaw) {
          lyDo = 'MDT thiếu thông tin: hóa đơn $0 hoặc không có momo người lập.';
        } else {
          const tgUtc = vnToUtc(tg);
          const msgs = [];
          for await (const m of history(gplmbCh, {
            limit: 500,
            after: addMs(tgUtc, -15 * 60_000),
            before: addMs(tgUtc, 15 * 60_000),
          })) {
            msgs.push(m.content.toLowerCase());
          }

          for (let k = 0; k < invoices.length; k++) {
            const tien = invoices[k];
            const momoTp = k < targets.length ? targets[k] : targets[targets.length - 1];
            const re = new RegExp(`!vipham\\s+${escapeRe(momoTp)}`);
            const foundVipham = msgs.some((t) => re.test(t));

            let valid = false;
            if (tien >= 23100) {
              valid = true; // Phạt kịch khung -> không cần dấu
            } else if (tien >= 7350) {
              if (foundVipham) valid = true;
              else
                lyDo =
                  `Không có \`!vipham\` cho **${momoTp}** trong ±15 phút quanh MDT. ` +
                  `Hóa đơn **$${money(tien)}** (đã gồm 5% thuế) dưới $22,000 nên bắt buộc đóng dấu.`;
            } else {
              lyDo = `Phạt sai mức: hóa đơn của **${momoTp}** chỉ **$${money(tien)}** (đã gồm 5% thuế), dưới mức tối thiểu $7,000.`;
            }
            if (valid) {
              isRowValid = true;
              break;
            }
          }
        }

        if (isRowValid) {
          cells.push(cell(actualRow, 15, 'Đã Check'));
          continue;
        }

        // Lập biên bản sai phạm
        const pings = new Set();
        const [mLap, uidLap] = this.resolveOfficerByMomo(momoLapRaw, momoToCs, guild);
        let officerMain = `**${mLap ?? momoLapRaw}**`;
        if (uidLap) {
          officerMain += ` (<@${uidLap}>)`;
          pings.add(`<@${uidLap}>`);
        }

        const lqDisplays = [];
        for (const raw of momosLqRaw.split(',').map((m) => m.trim()).filter((m) => m && m !== momoLapRaw)) {
          const [mLq, uidLq] = this.resolveOfficerByMomo(raw, momoToCs, guild);
          if (!mLq) continue;
          let d = `**${mLq}**`;
          if (uidLq) {
            d += ` (<@${uidLq}>)`;
            pings.add(`<@${uidLq}>`);
          }
          lqDisplays.push(d);
        }
        const uniqueLq = uniq(lqDisplays);

        const embed = new EmbedBuilder()
          .setTitle('📋 Vi phạm MDT BLHT')
          .setColor(COLORS.red)
          .setThumbnail('https://i.imgur.com/8Qe5u9e.png')
          .addFields({ name: '👮 Người lập', value: officerMain, inline: false });
        if (uniqueLq.length) embed.addFields({ name: '👥 Liên quan', value: uniqueLq.join('\n').slice(0, 1024), inline: false });
        embed.addFields(
          { name: '🎯 Đối tượng (momo)', value: momoTpRaw ? `**${momoTpRaw}**` : '*(trống)*', inline: true },
          { name: '📑 ID MDT', value: `**${idMdt}**\n*(${tgStr})*`, inline: true },
          {
            name: '⚠️ Lý do',
            value: (
              `${lyDo}\n\n` +
              'Quy định:\n' +
              '- Có GPLMB: phạt $7,000 - $10,000 và bắt buộc đóng dấu `!vipham`.\n' +
              '- Không GPLMB: tổng hóa đơn tối thiểu **$22,000**.\n\n' +
              'Yêu cầu những người liên quan giải trình.'
            ).slice(0, 1024),
            inline: false,
          },
        );
        embed.setFooter({ text: 'GCPD • Kiểm tra tự động' });

        try {
          await doiBay.send({
            content: `🚨 **VI PHẠM MDT BLHT** ${roleMentionStr} ${[...pings].join(' ')}`,
            embeds: [embed],
            allowedMentions: { parse: ['roles', 'users'] },
          });
          cells.push(cell(actualRow, 15, 'Đã Check'));
        } catch (e) {
          console.error('Lỗi không gửi được cảnh báo BLHT:', e.message);
        }
      }

      if (cells.length) await this.bot.sheets.incident.updateCells(cells);
    } catch (e) {
      console.error('Lỗi vòng lặp Checker BLHT:', e.message);
    }
  }
}
