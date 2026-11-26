import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, COLORS, history, nowVN, toVN, vnToUtc, addMs, DAY_MS, startOfDay, endOfDay, weekday, fmt, parseDMY, isBotAdmin, NO_PERM } from '../utils.js';

const DAYS_VN = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];
const PLANE = 'hoạt động buôn hàng trắng bằng máy bay';

// Bản đồ cột ghi vào sheet Dispatch (A=0 ... P=15)
const DISPATCH_COLS = {
  'hoạt động buôn hàng trắng bằng máy bay': 2,
  'trộm biển báo': 3,
  'người dân đào quặng lậu': 4,
  'hoạt động rã xe bất hợp pháp đang diễn ra': 5,
  'vụ cướp cửa hàng đang diễn ra': 6,
  'trộm xe đang diễn ra': 7,
  'phát hiện hoạt động chặt gỗ bất hợp pháp': 8,
  'người dân bán bột mì': 9,
  'có một vụ trộm nhà đang diễn ra': 10,
  'có một vụ trộm linh kiện điện tử': 11,
  'có một vụ trộm cún': 12,
  'cướp giật': 13,
  'hàng trắng trực thăng premium': 14,
  'hàng trắng trực thăng': 15,
};

const p2 = (n) => String(n).padStart(2, '0');

function incidentNameOf(embed) {
  const header = `${embed.title ?? ''} ${embed.author?.name ?? ''}`;
  const m = /\d+-\d+\s*-\s*([^\n]+)/.exec(header);
  return m ? m[1].trim().replace(/[*`]/g, '') : null;
}

function creatorIdOf(embed) {
  let text = `${embed.description ?? ''}\n`;
  for (const f of embed.fields ?? []) text += `${f.name}\n${f.value}\n`;
  const m = /ID:\s*(\d+)/i.exec(text);
  return m ? m[1].trim() : 'UNKNOWN';
}

// Lọc spam: máy bay cùng người tạo trong 10 phút chỉ tính 1 lần. Trả về true nếu cần bỏ qua.
function isPlaneSpam(lastSeen, embed, message) {
  const creator = creatorIdOf(embed);
  const t = message.createdTimestamp;
  const prev = lastSeen.get(creator);
  lastSeen.set(creator, t);
  return prev !== undefined && (t - prev) / 1000 <= 600;
}

// Thống kê dispatch theo ngày -> sheet Dispatch; báo cáo ra Discord
export default class Dispatch extends Cog {
  constructor(bot) {
    super(bot);
    this.commands = {
      updatedispatch: (ctx, a, b) => this.updateDispatch(ctx, a, b),
      dispatch: (ctx, a, b) => this.dispatchStat(ctx, a, b),
      dispatchlist: (ctx, l) => this.dispatchList(ctx, l),
    };
    // 23:59 giờ VN = 16:59 UTC
    this.dailyAtUTC('auto_daily_dispatch', 16, 59, () => this.autoDaily());
  }

  hasPerm(member) {
    return isBotAdmin(member);
  }

  // Đọc tham số ngày; mặc định = hôm qua. Trả về { start, end, title } hoặc null nếu sai định dạng
  parseRange(fromStr, toStr) {
    if (!fromStr) {
      const y = addMs(nowVN(), -DAY_MS);
      return { start: startOfDay(y), end: endOfDay(y), title: `ngày ${fmt(y, 'DD/MM/YYYY')}` };
    }
    const start = parseDMY(fromStr);
    if (!start) return null;
    if (toStr) {
      const toDay = parseDMY(toStr);
      if (!toDay) return null;
      return { start, end: endOfDay(toDay), title: `từ ${fmt(start, 'DD/MM/YYYY')} đến ${fmt(toDay, 'DD/MM/YYYY')}` };
    }
    return { start, end: endOfDay(start), title: `ngày ${fmt(start, 'DD/MM/YYYY')}` };
  }

  async processAndSync(startVn, endVn, channel) {
    const daily = new Map();
    const lastSeen = new Map();

    for await (const message of history(channel, { limit: null, after: vnToUtc(startVn), before: vnToUtc(endVn), oldestFirst: true })) {
      if (!message.embeds.length) continue;
      const embed = message.embeds[0];
      const name = incidentNameOf(embed);
      if (!name) continue;
      const lower = name.toLowerCase();

      if (lower === PLANE && isPlaneSpam(lastSeen, embed, message)) continue;
      if (!(lower in DISPATCH_COLS)) continue;

      const msgVn = toVN(message.createdAt);
      const key = fmt(msgVn, 'DD/MM/YYYY');
      if (!daily.has(key)) {
        const row = Array(16).fill('');
        row[0] = `${DAYS_VN[weekday(msgVn)]}, ${key}`;
        for (let i = 2; i < 16; i++) row[i] = 0;
        daily.set(key, row);
      }
      daily.get(key)[DISPATCH_COLS[lower]] += 1;
    }

    if (!daily.size) return [0, 0];

    const sheet = this.bot.sheets.dispatch;
    if (!sheet) throw new Error('Chưa khai báo sheet Dispatch trong index.js!');
    const allRows = await sheet.getAllValues();

    const dateToRow = new Map();
    allRows.forEach((row, idx) => {
      if (!row.length) return;
      const m = /(\d{2}\/\d{2}\/\d{4})/.exec(String(row[0]).trim());
      if (m) dateToRow.set(m[1], idx + 1);
    });

    const cells = [];
    const appends = [];
    const keys = [...daily.keys()].sort((a, b) => parseDMY(a) - parseDMY(b));
    for (const key of keys) {
      const rowData = daily.get(key);
      const formatted = rowData.map((v) => (v !== 0 ? String(v) : ''));
      formatted[0] = rowData[0];
      if (dateToRow.has(key)) {
        const r = dateToRow.get(key);
        for (let c = 0; c < 16; c++) cells.push(cell(r, c + 1, formatted[c]));
      } else {
        appends.push(formatted);
      }
    }

    if (cells.length) await sheet.updateCells(cells);
    if (appends.length) await sheet.appendRows(appends);
    return [cells.length / 16, appends.length];
  }

  async autoDaily() {
    console.log('[Dispatch] Bắt đầu ghi tổng kết Dispatch cuối ngày');
    const now = nowVN();
    const channel = this.bot.channels.cache.get(ROOMS.DISPATCH);
    if (!channel) return console.error('[Dispatch] LỖI: không thấy kênh Dispatch');
    try {
      const [u, a] = await this.processAndSync(startOfDay(now), endOfDay(now), channel);
      console.log(`[Dispatch] Ghi tổng kết xong: cập nhật ${u} ngày, thêm ${a} ngày`);
    } catch (e) {
      console.error('[Dispatch] LỖI ghi tổng kết:', e.message);
    }
  }

  // /updatedispatch [dd/mm/yyyy] [dd/mm/yyyy]
  async updateDispatch(ctx, fromStr, toStr) {
    if (!this.hasPerm(ctx.author)) return ctx.send(NO_PERM);
    const r = this.parseRange(fromStr, toStr);
    if (!r) return ctx.send('⚠️ Cú pháp: `/updatedispatch [dd/mm/yyyy] [dd/mm/yyyy]`\nVí dụ: `/updatedispatch 01/11/2026 07/11/2026`');

    const msg = await ctx.send(`⏳ Đang đồng bộ Dispatch ${r.title} lên Sheets...`);
    try {
      const channel = this.bot.channels.cache.get(ROOMS.DISPATCH);
      if (!channel) return msg.edit('❌ Không tìm thấy kênh Dispatch (kiểm tra ID phòng).');
      const [u, a] = await this.processAndSync(r.start, r.end, channel);
      if (u === 0 && a === 0) await msg.edit(`📭 Không có dữ liệu Dispatch ${r.title}.`);
      else await msg.edit(`✅ Đồng bộ Dispatch xong: cập nhật **${u}** ngày, thêm mới **${a}** ngày.`);
    } catch (e) {
      await msg.edit(`❌ Lỗi: ${e.message}`);
    }
  }

  // /dispatch [dd/mm/yyyy] [dd/mm/yyyy]
  async dispatchStat(ctx, fromStr, toStr) {
    if (!this.hasPerm(ctx.author)) return ctx.send(NO_PERM);
    const r = this.parseRange(fromStr, toStr);
    if (!r) return ctx.send('⚠️ Cú pháp: `/dispatch [dd/mm/yyyy] [dd/mm/yyyy]`\nVí dụ: `/dispatch 01/11/2026 07/11/2026`');

    const msg = await ctx.send(`⏳ Đang thống kê Dispatch ${r.title}...`);
    try {
      const channel = this.bot.channels.cache.get(ROOMS.DISPATCH);
      if (!channel) return msg.edit('❌ Không tìm thấy kênh Dispatch!');

      const data = new Map(); // name -> { total, brackets: Map }
      let total = 0;
      const lastSeen = new Map();

      for await (const message of history(channel, { limit: null, after: vnToUtc(r.start), before: vnToUtc(r.end), oldestFirst: true })) {
        if (!message.embeds.length) continue;
        const embed = message.embeds[0];
        const name = incidentNameOf(embed);
        if (!name) continue;

        const h = Math.floor(toVN(message.createdAt).getUTCHours() / 2) * 2;
        const bracket = `${p2(h)}h-${p2(h + 2)}h`;

        if (name.toLowerCase() === PLANE && isPlaneSpam(lastSeen, embed, message)) continue;

        if (!data.has(name)) data.set(name, { total: 0, brackets: new Map() });
        const d = data.get(name);
        d.total++;
        d.brackets.set(bracket, (d.brackets.get(bracket) ?? 0) + 1);
        total++;
      }

      if (!data.size) return msg.edit(`📭 Không có Dispatch nào ${r.title}.`);

      const sorted = [...data.entries()].sort((a, b) => b[1].total - a[1].total);
      let stat = '';
      for (const [name, d] of sorted) {
        const br = [...d.brackets.entries()]
          .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
          .map(([b, c]) => `${b}: \`${c}\``)
          .join(' | ');
        const line = `**${name}**: \`${d.total}\` vụ\n└ ${br}\n\n`;
        if (stat.length + line.length < 4000) stat += line;
        else {
          stat += '...\n*(Vượt quá giới hạn)*';
          break;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`📊 Dispatch ${r.title}`)
        .setColor(COLORS.red)
        .setThumbnail('https://i.imgur.com/8Qe5u9e.png')
        .setDescription(`Tổng: \`${total}\` vụ\n\n${stat}`.slice(0, 4096))
        .setFooter({ text: 'GCPD Dispatch' });

      await msg.edit({ content: null, embeds: [embed] });
    } catch (e) {
      await msg.edit(`❌ Lỗi: ${e.message}`);
    }
  }

  // /dispatchlist [limit]
  async dispatchList(ctx, limitArg) {
    if (!this.hasPerm(ctx.author)) return ctx.send(NO_PERM);
    const limit = limitArg && /^\d+$/.test(limitArg) ? parseInt(limitArg, 10) : 5000;

    const msg = await ctx.send(`⏳ Đang quét **${limit}** log Dispatch gần nhất...`);
    try {
      const channel = this.bot.channels.cache.get(ROOMS.DISPATCH);
      if (!channel) return msg.edit('❌ Không tìm thấy kênh Dispatch!');

      const unique = new Set();
      for await (const message of history(channel, { limit })) {
        if (!message.embeds.length) continue;
        const name = incidentNameOf(message.embeds[0]);
        if (name) unique.add(name);
      }
      if (!unique.size) return msg.edit('📭 Không tìm thấy loại Dispatch nào.');

      const list = [...unique].sort();
      let desc = '';
      for (let i = 0; i < list.length; i++) {
        const line = `**${i + 1}.** ${list[i]}\n`;
        if (desc.length + line.length < 4000) desc += line;
        else {
          desc += '...\n*(Vượt quá giới hạn)*';
          break;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 Các loại Dispatch')
        .setColor(COLORS.blue)
        .setDescription(desc)
        .setFooter({ text: `Tổng: ${list.length} loại` });
      await msg.edit({ content: null, embeds: [embed] });
    } catch (e) {
      await msg.edit(`❌ Lỗi: ${e.message}`);
    }
  }
}
