import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, SHEET_IDS } from '../config.js';
import {
  S, at, toInt, cleanMoney, isDigits, money, fmtG, nowVN, addMs, DAY_MS, parseDMY, parseYMDHMS, weekSheetName, currentWeekStartVN, isBotAdmin, callsignOf, layIdTheoCallsign, layMemberTheoCallsign, COLORS, NO_PERM,
} from '../utils.js';

const MEDALS = ['🥇', '🥈', '🥉', '**#4**', '**#5**', '**#6**', '**#7**', '**#8**', '**#9**', '**#10**'];
const EXEMPT_ROLES = ['Hội Đồng Ủy Ban', 'Giảng Viên', 'Tòa Thị Chính', 'Uỷ Viên Chính Phủ', 'FTO'];

// Nhận diện form tab tuần theo số cột tiêu đề:
//  v1 = 12 cột (form rất cũ), v2 = 25 cột, v3 = 32 cột (form hiện tại: Chức vụ, Lập/Tham gia MDT, Thưởng OT, FTO, Đền bù bay...)
const kpiFormat = (header) => (!header ? 'v1' : header.length >= 30 ? 'v3' : header.length >= 15 ? 'v2' : 'v1');
const KPI_COL = { v1: 6, v2: 12, v3: 5 }; // cột tổng vụ án / KPI tuần
const TONG_COL = { v1: 11, v2: 24, v3: 31 }; // cột tổng thưởng

function moneyNum(row, idx) {
  const clean = [...String(row[idx] ?? '')].filter((c) => /[0-9-]/.test(c)).join('');
  const val = parseInt(clean, 10);
  return Number.isNaN(val) ? 0 : val;
}
const fmtMoney = (val) => (val >= 0 ? `$${money(val)}` : `-$${money(Math.abs(val))}`);

function parseMoneyFromRow(row, idx) {
  if (row.length > idx) {
    const clean = [...String(row[idx])].filter((c) => /[0-9-]/.test(c)).join('');
    if (clean && clean !== '-') {
      const val = parseInt(clean, 10);
      if (!Number.isNaN(val)) return val >= 0 ? `$${money(val)}` : `-$${money(Math.abs(val))}`;
    }
  }
  return '$0';
}

function parseWeeklyTime(v) {
  v = S(v);
  if (!v || ['00:00', '0:00', '0', '-'].includes(v)) return '0';
  if (v.includes(':')) {
    const [h, rest] = [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)];
    return `${isDigits(h) ? parseInt(h, 10) : 0}.${rest}`;
  }
  return v;
}

// KPI tuần: /top, /kpi, /lamviec
export default class KPI extends Cog {
  constructor(bot) {
    super(bot);
    this.lastTopTime = 0;
    this.kpiCache = new Map();
    this.hoadonCache = [];
    this.hoadonCacheTime = 0;
    this.commands = {
      top: (ctx, s) => this.top(ctx, s),
      kpi: (ctx, a, b) => this.kpi(ctx, a, b),
      lamviec: (ctx) => this.lamviec(ctx),
    };
  }

  async fetchKpiData(sheetName) {
    const c = this.kpiCache.get(sheetName);
    if (c && Date.now() - c.t < 60_000) return c.data;
    const ws = await this.bot.gs.worksheet(SHEET_IDS.MAIN, sheetName);
    const data = await ws.getAllValues();
    this.kpiCache.set(sheetName, { data, t: Date.now() });
    return data;
  }

  async fetchHoadonData() {
    if (this.hoadonCache.length && Date.now() - this.hoadonCacheTime < 60_000) return this.hoadonCache;
    this.hoadonCache = await this.bot.sheets.hoadon.getAllValues();
    this.hoadonCacheTime = Date.now();
    return this.hoadonCache;
  }

  // Trả về { sheetName, start, currSheet } hoặc null nếu sai định dạng tuần
  weekInfo(sheetNameArg) {
    const currStart = currentWeekStartVN();
    const currSheet = weekSheetName(currStart);
    if (!sheetNameArg) return { sheetName: currSheet, start: currStart, currSheet };
    const start = parseDMY(`${sheetNameArg.split('-')[0]}/${nowVN().getUTCFullYear()}`);
    if (!start) return null;
    return { sheetName: sheetNameArg, start, currSheet };
  }

  // ==========================================
  // /top [tuần]
  // ==========================================
  async top(ctx, sheetNameArg) {
    if (ctx.channel.id !== ROOMS.KPI) return;
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);

    const nowMs = Date.now();
    if (this.lastTopTime && nowMs - this.lastTopTime < 10_000) {
      return ctx.send(`⚠️ Bot đang tải dữ liệu, thử lại sau **${Math.trunc(10 - (nowMs - this.lastTopTime) / 1000)}s**.`);
    }
    this.lastTopTime = nowMs;

    const w = this.weekInfo(sheetNameArg);
    if (!w) return ctx.send('❌ Tuần không hợp lệ. Ví dụ: `/top 31/8-6/9`');
    const reqEnd = addMs(w.start, 7 * DAY_MS - 1000);

    try {
      const loading = await ctx.send('⏳ Đang tải bảng xếp hạng...');

      const momoToCurrentCs = new Map();
      try {
        if (w.sheetName !== w.currSheet) {
          const cur = await this.fetchKpiData(w.currSheet);
          for (const row of cur.slice(1)) if (row.length >= 2) momoToCurrentCs.set(S(row[1]), S(row[0]));
        }
      } catch {
        /* bỏ qua */
      }

      const momoToCs = new Map();
      const topKpi = [];
      const k = await this.fetchKpiData(w.sheetName);
      const kCol = KPI_COL[kpiFormat(k[0])];

      for (const row of k.slice(1)) {
        const cn = S(at(row, 0));
        const mid = S(at(row, 1));
        const kn = toInt(at(row, kCol));
        if (mid && cn) momoToCs.set(mid, cn);
        if (kn > 0) {
          const act = momoToCurrentCs.get(mid) ?? cn;
          const uid = layIdTheoCallsign(ctx.guild, act);
          topKpi.push([uid ? `<@${uid}>` : `**[${act}] ${at(row, 2)}**`, mid, kn]);
        }
      }
      topKpi.sort((a, b) => b[2] - a[2]);

      const hd = await this.fetchHoadonData();
      const totals = new Map();
      for (const h of hd.slice(1)) {
        if (h.length < 7) continue;
        const d = parseYMDHMS(String(h[0]).replace(/'/g, ''));
        if (!d || d < w.start || d > reqEnd) continue;
        const mid = S(h[2]);
        const v = cleanMoney(h[6]);
        if (isDigits(v)) totals.set(mid, (totals.get(mid) ?? 0) + parseInt(v, 10));
      }

      const topMoney = [];
      for (const [mid, total] of totals) {
        const tien = Math.trunc(total / 1.05);
        if (tien <= 0) continue;
        const cn = momoToCs.get(mid) ?? null;
        const act = momoToCurrentCs.get(mid) ?? cn;
        const uid = act ? layIdTheoCallsign(ctx.guild, act) : null;
        const dName = uid ? `<@${uid}>` : act ? `**[${act}]**` : `**Momo ${mid}**`;
        topMoney.push([dName, mid, tien]);
      }
      topMoney.sort((a, b) => b[2] - a[2]);

      const descMoney = topMoney.length
        ? topMoney.slice(0, 10).map(([d, m, t], i) => `${MEDALS[i]} ${d} (Momo: ${m}) - **$${money(t)}**`).join('\n') + '\n'
        : '📭 Chưa có dữ liệu.\n';
      const descKpi = topKpi.length
        ? topKpi.slice(0, 10).map(([d, m, n], i) => `${MEDALS[i]} ${d} (Momo: ${m}) - **${n} vụ**`).join('\n') + '\n'
        : '📭 Chưa có dữ liệu.\n';

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Bảng xếp hạng tuần ${w.sheetName}`)
        .setColor(COLORS.gold)
        .addFields(
          { name: '💰 Top 10 tiền hóa đơn', value: descMoney.slice(0, 1024), inline: false },
          { name: '🕵️ Top 10 KPI vụ án', value: descKpi.slice(0, 1024), inline: false },
        )
        .setFooter({ text: 'GCPD • Dữ liệu tự động' });

      await loading.delete().catch(() => {});
      await ctx.send({ embeds: [embed] });
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // /kpi | /kpi <tuần> | /kpi <momo> | /kpi <momo> <tuần>
  // ==========================================
  async kpi(ctx, arg1, arg2) {
    if (ctx.channel.id !== ROOMS.KPI) return;

    let targetMomo = null;
    let sheetNameArg = null;
    if (arg1) {
      if (arg1.includes('/') && arg1.includes('-')) sheetNameArg = arg1;
      else if (isDigits(arg1)) {
        targetMomo = arg1;
        if (arg2) sheetNameArg = arg2;
      }
    }

    if (targetMomo && !isBotAdmin(ctx.author)) {
      return ctx.reply(NO_PERM);
    }

    const w = this.weekInfo(sheetNameArg);
    if (!w) return ctx.reply('❌ Tuần không hợp lệ. Ví dụ: `/kpi 31/8-6/9`');

    const prevStart = addMs(w.start, -7 * DAY_MS);
    const prevEnd = addMs(prevStart, 6 * DAY_MS);
    const [d1, m1, d2, m2] = [prevStart.getUTCDate(), prevStart.getUTCMonth() + 1, prevEnd.getUTCDate(), prevEnd.getUTCMonth() + 1];
    const pad = (n) => String(n).padStart(2, '0');
    const prevSheets = [
      `${d1}/${m1}-${d2}/${m2}`,
      `${pad(d1)}/${pad(m1)}-${pad(d2)}/${pad(m2)}`,
      `${d1}/${m1} - ${d2}/${m2}`,
      `${pad(d1)}/${pad(m1)} - ${pad(d2)}/${pad(m2)}`,
    ];

    try {
      let searchKey, searchValue, targetDisplay, roles;
      if (!targetMomo) {
        searchKey = 'CALLSIGN';
        searchValue = callsignOf(ctx.author.displayName);
        targetDisplay = ctx.author.displayName;
        roles = ctx.author.roles.cache.map((r) => r.name);
      } else {
        searchKey = 'MOMO';
        searchValue = targetMomo;
        targetDisplay = 'Chưa rõ';
        roles = [];
      }

      const k = await this.fetchKpiData(w.sheetName);
      const form = kpiFormat(k[0]);
      const newFmt = form === 'v2';

      for (const row of k.slice(1)) {
        const match =
          (searchKey === 'CALLSIGN' && S(at(row, 0)) === searchValue) ||
          (searchKey === 'MOMO' && row.length > 1 && S(row[1]) === searchValue);
        if (!match) continue;

        const cn = S(row[0]);
        const mid = S(row[1]);

        if (searchKey === 'MOMO') {
          const ten = row.length > 2 ? S(row[2]) : 'Không rõ';
          const chucVu = row.length > 3 ? S(row[3]) : 'Không rõ';
          targetDisplay = `${cn} | ${chucVu} | ${ten}`;
          if (chucVu.toUpperCase().includes('DPUN')) roles.push('D.P.U.N');
        }

        const gioiTinhRaw = row.length > 4 ? S(row[4]).toUpperCase() : '';
        const gioiTinh = gioiTinhRaw === 'NỮ' ? 'Nữ ♀️' : 'Nam ♂️';

        let gioTrucRaw, ngayTruc, kNum, mdtMatDat, blhtTong, blhtLap, blhtHtro;
        if (form === 'v3') {
          gioTrucRaw = S(at(row, 13)).replace(',', '.') || '0';
          ngayTruc = toInt(at(row, 14));
          kNum = toInt(at(row, 5));
        } else if (newFmt) {
          gioTrucRaw = row.length > 10 ? S(row[10]).replace(',', '.') : '0';
          ngayTruc = toInt(at(row, 11));
          kNum = toInt(at(row, 12));
          mdtMatDat = row.length > 5 ? S(row[5]) : '0';
          blhtTong = row.length > 7 ? S(row[7]) : '0';
          blhtLap = row.length > 8 ? S(row[8]) : '0';
          blhtHtro = row.length > 9 ? S(row[9]) : '0';
        } else {
          gioTrucRaw = row.length > 4 ? S(row[4]).replace(',', '.') : '0';
          ngayTruc = toInt(at(row, 5));
          kNum = toInt(at(row, 6));
          mdtMatDat = blhtTong = blhtLap = blhtHtro = 'N/A';
        }
        let gioTruc = Number(gioTrucRaw);
        if (!gioTrucRaw || Number.isNaN(gioTruc)) gioTruc = 0;

        const wtStart = form === 'v3' ? 15 : 13;
        const wt = form !== 'v1'
          ? Array.from({ length: 7 }, (_, i) => parseWeeklyTime(at(row, wtStart + i) || '0'))
          : Array(7).fill('0');

        const moneyIdx = newFmt ? [20, 21, 22, 23, 24] : [7, 8, 9, 10, 11];
        const [thuongKpi, thuong113, thuongBay, thuongBoSung, thuongTong] = moneyIdx.map((i) => parseMoneyFromRow(row, i));

        let thuongTuanTruoc = '$0';
        let prevDisplay = prevSheets[0];
        for (const sName of prevSheets) {
          try {
            const prev = await this.fetchKpiData(sName);
            if (prev && prev.length) {
              prevDisplay = sName;
              const prevTong = TONG_COL[kpiFormat(prev[0])];
              for (const p of prev.slice(1)) {
                if (p.length > 1 && S(p[1]) === mid) {
                  thuongTuanTruoc = parseMoneyFromRow(p, prevTong);
                  break;
                }
              }
              break;
            }
          } catch {
            continue;
          }
        }

        // Ưu ái 50% chỉ tiêu cho Sĩ quan nữ
        const vuBase = roles.includes('D.P.U.N') ? 20 : 10;
        const isNu = gioiTinhRaw === 'NỮ';
        const targetVu = isNu ? Math.trunc(vuBase * 0.5) : vuBase;
        const targetGio = isNu ? 14 * 0.5 : 14;
        const targetNgay = isNu ? 5 * 0.5 : 5;

        let desc = `👮 Sĩ quan: **${targetDisplay}**\n`;
        if (form === 'v3' && S(at(row, 3))) desc += `🎖️ Chức vụ: **${S(at(row, 3))}**\n`;
        desc += `🆔 Momo: **${mid}**\n`;
        desc += `🚻 Giới tính: ${gioiTinh}\n\n`;
        desc += '📋 **Chỉ tiêu tuần**\n';
        desc += `• Giờ trực: \`${fmtG(gioTruc)} / ${fmtG(targetGio)}\` giờ\n`;
        if (form !== 'v1') desc += `  *(T2: ${wt[0]} | T3: ${wt[1]} | T4: ${wt[2]} | T5: ${wt[3]} | T6: ${wt[4]} | T7: ${wt[5]} | CN: ${wt[6]})*\n`;
        desc += `• Ngày trực: \`${ngayTruc} / ${fmtG(targetNgay)}\` ngày\n`;
        desc += `• Vụ án MDT: \`${kNum} / ${targetVu}\` vụ\n`;
        if (form === 'v3') {
          const n = (i) => toInt(at(row, i));
          desc += `  ↳ *Lập MDT: ${n(6)} - Hỗ trợ: ${n(7)}*\n`;
          desc += `  ↳ *BLHT: ${n(10)} (Lập: ${n(11)}, Hỗ trợ: ${n(12)})*\n`;
          desc += `  ↳ *Mặt đất: ${n(8) + n(9)} (Lập: ${n(8)}, Hỗ trợ: ${n(9)})*\n`;
        } else if (newFmt) {
          desc += `  ↳ *BLHT: ${blhtTong} (Lập: ${blhtLap}, Hỗ trợ: ${blhtHtro})*\n`;
          desc += `  ↳ *Mặt đất: ${mdtMatDat}*\n`;
        }
        desc += '\n';
        desc += '💰 **Lương thưởng**\n';
        if (form === 'v3') {
          const m = (i) => fmtMoney(moneyNum(row, i));
          desc += `• Chuyên cần: \`${m(23)}\`\n`;
          desc += `• Thưởng OT: \`${m(22)}\`\n`;
          desc += `• Trách nhiệm + Phụ cấp: \`${fmtMoney(moneyNum(row, 24) + moneyNum(row, 27))}\`\n`;
          desc += `• Thưởng KPI: \`${m(25)}\`\n`;
          if (moneyNum(row, 26)) desc += `• Thưởng FTO: \`${m(26)}\`\n`;
          desc += `• Thưởng MDT BLHT: \`${m(28)}\`\n`;
          desc += `• Bồi thường BLHT: \`${m(29)}\`\n`;
          desc += `• Bổ sung: \`${m(30)}\`\n`;
          desc += '────────────────────\n';
          desc += `💵 Tổng nhận (${w.sheetName}): **${m(31)}**\n`;
          desc += `📆 Thưởng tuần trước (${prevDisplay}): **${thuongTuanTruoc}**\n\n`;
        } else {
          desc += `• Chuyên cần + Trách nhiệm + KPI: \`${thuongKpi}\`\n`;
          desc += `• Thưởng 113: \`${thuong113}\`\n`;
          desc += `• Thưởng Đội Bay: \`${thuongBay}\`\n`;
          desc += `• Bổ sung: \`${thuongBoSung}\`\n`;
          desc += '────────────────────\n';
          desc += `💵 Tổng nhận (${w.sheetName}): **${thuongTong}**\n`;
          desc += `📆 Lương tuần trước (${prevDisplay}): **${thuongTuanTruoc}**\n\n`;
        }

        const embed = new EmbedBuilder()
          .setTitle(`📊 KPI tuần ${w.sheetName}` + (searchKey === 'MOMO' ? ' (tra cứu)' : ''))
          .setColor(COLORS.blurple)
          .setDescription(desc)
          .setFooter({ text: 'MDT Database • GCPD' });

        return ctx.reply({ embeds: [embed] });
      }

      if (searchKey === 'CALLSIGN') await ctx.reply(`📭 Không tìm thấy callsign **${searchValue}** trong tuần **${w.sheetName}**.`);
      else await ctx.reply(`📭 Không tìm thấy momo **${searchValue}** trong tuần **${w.sheetName}**.`);
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // /lamviec - ping Sĩ quan 0 KPI tuần này
  // ==========================================
  async lamviec(ctx) {
    if (ctx.channel.id !== ROOMS.KPI) return;
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);

    const currSheet = weekSheetName(currentWeekStartVN());
    try {
      await ctx.send(`⏳ Đang tìm người 0 KPI tuần **${currSheet}**...`);
      const data = await this.fetchKpiData(currSheet);
      const kCol = KPI_COL[kpiFormat(data[0])];

      const slackers = [];
      for (const row of data.slice(1)) {
        // FIX: bản Python dùng lại giá trị của dòng trước khi dòng hiện tại thiếu cột
        if (row.length <= kCol) continue;
        const cn = S(row[0]);
        const kn = toInt(row[kCol]);
        if (!cn || kn !== 0) continue;
        const m = layMemberTheoCallsign(ctx.guild, cn);
        if (!m) continue;
        const r = m.roles.cache.map((x) => x.name);
        if ((r.includes('D.P.U.N') || r.includes('GCPD')) && !EXEMPT_ROLES.some((x) => r.includes(x))) {
          slackers.push(`<@${m.id}>`);
        }
      }

      if (!slackers.length) await ctx.send('✅ Không có ai 0 KPI tuần này.');
      else await ctx.send(`🚨 **0 KPI TUẦN ${currSheet}** (**${slackers.length}** người)\n` + slackers.join(' '));
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }
}
