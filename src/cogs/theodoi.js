import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, SHEET_IDS } from '../config.js';
import { S, fmt, nowVN, toVN, isBotAdmin, NO_PERM, csToMemberMap } from '../utils.js';

// ==========================================
// THEO DÕI ĐẶC BIỆT
// Momo trong danh sách theo dõi nhận dispatch hàng trắng bằng máy bay / trực thăng
// -> báo vào room THEO_DOI, tag các PD được giao theo dõi (thêm theo callsign).
// File GCPD DATA:
//   tab "Theo-Doi"    A Momo | B Ghi chú | C Người thêm | D Thời gian thêm      (đối tượng bị theo dõi)
//   tab "Theo-Doi-PD" A Callsign | B Người thêm | C Thời gian thêm              (PD được tag khi có báo)
// Quản lý (chỉ gõ trong room THEO_DOI):
//   /theodoi <momo> [ghi chú] · /botheodoi <momo> · /dstheodoi
//   /themnguoitheodoi <callsign> [callsign ...] · /bonguoitheodoi <callsign>
// ==========================================
const TAB = 'Theo-Doi';
const HEADER = ['Momo', 'Ghi chú', 'Người thêm', 'Thời gian thêm'];
const PD_TAB = 'Theo-Doi-PD';
const PD_HEADER = ['Callsign', 'Người thêm', 'Thời gian thêm'];
const COOLDOWN_MS = 10 * 60_000; // cùng momo + cùng loại dispatch trong 10 phút chỉ báo 1 lần

// "10-90 - Hoạt động buôn hàng trắng bằng máy bay" -> tên vụ (giống dispatch.js)
function incidentNameOf(embed) {
  const header = `${embed.title ?? ''} ${embed.author?.name ?? ''}`;
  const m = /\d+-\d+\s*-\s*([^\n]+)/.exec(header);
  return m ? m[1].trim().replace(/[*`]/g, '') : null;
}
// ID người tạo dispatch (= momo / ID ingame)
function creatorIdOf(embed) {
  let text = `${embed.description ?? ''}\n`;
  for (const f of embed.fields ?? []) text += `${f.name}\n${f.value}\n`;
  const m = /ID:\s*(\d+)/i.exec(text);
  return m ? m[1] : null;
}
// Buôn hàng trắng bằng máy bay, Hàng trắng trực thăng (thường + premium)
const isWatchedDispatch = (name) => {
  const n = name.toLowerCase();
  return n.includes('hàng trắng') && (n.includes('máy bay') || n.includes('trực thăng'));
};

export default class TheoDoi extends Cog {
  constructor(bot) {
    super(bot);
    this.cache = null; // { list: Map momo -> { note, row }, t }
    this.lastAlert = new Map(); // `${momo}|${loại}` -> ms
    this.lastMemberFetch = 0;
    this.commands = {
      theodoi: (ctx, momo, ...note) => this.add(ctx, momo, note.join(' ')),
      botheodoi: (ctx, momo) => this.remove(ctx, momo),
      dstheodoi: (ctx) => this.list(ctx),
      themnguoitheodoi: (ctx, ...cs) => this.addPd(ctx, cs),
      bonguoitheodoi: (ctx, cs) => this.removePd(ctx, cs),
    };
  }

  room() {
    return this.bot.channels.cache.get(ROOMS.THEO_DOI) ?? null;
  }

  async sheet(tab = TAB, header = HEADER) {
    const [ws] = await this.bot.gs.ensureWorksheet(SHEET_IDS.MAIN, tab, { cols: header.length });
    const rows = await ws.getAllValues();
    if (!rows.length || S(rows[0][0]) !== header[0]) {
      await ws.updateRange('A1', [header]);
      if (!rows.length) rows.push([...header]);
      else rows[0] = [...header];
    }
    return { ws, rows };
  }

  // Callsign các PD được tag khi có báo
  async pdList() {
    const { rows } = await this.sheet(PD_TAB, PD_HEADER);
    return rows.slice(1).map((r) => S(r[0]).replace(/^'/, '')).filter(Boolean);
  }

  async members(guild) {
    if (Date.now() - this.lastMemberFetch > 10 * 60_000) {
      this.lastMemberFetch = Date.now();
      await guild.members.fetch().catch((e) => console.error('[TheoDoi] LỖI tải thành viên:', e.message));
    }
    return csToMemberMap(guild);
  }

  // /themnguoitheodoi <callsign> [callsign ...]
  async addPd(ctx, csArgs) {
    if (!(await this.guard(ctx))) return;
    const wanted = [...new Set(csArgs.map(S).filter(Boolean))];
    if (!wanted.length) return ctx.reply('⚠️ Cú pháp: `/themnguoitheodoi <callsign> [callsign ...]`. Ví dụ: `/themnguoitheodoi 609 234`');
    const { ws, rows } = await this.sheet(PD_TAB, PD_HEADER);
    const have = new Set(rows.slice(1).map((r) => S(r[0]).replace(/^'/, '')));
    const csMap = await this.members(ctx.guild);
    const added = [];
    const skipped = [];
    for (const cs of wanted) {
      if (have.has(cs)) skipped.push(`**${cs}** (đã có)`);
      else if (!csMap.has(cs)) skipped.push(`**${cs}** (không thấy ai có callsign này trên Discord)`);
      else added.push(cs);
    }
    const when = fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss');
    if (added.length) await ws.appendRows(added.map((cs) => [`'${cs}`, `'${ctx.author.displayName}`, `'${when}`]));
    return ctx.reply(
      [
        added.length ? `✅ Đã thêm người theo dõi: ${added.map((cs) => csMap.get(cs)?.displayName ?? cs).join(', ')}` : '',
        skipped.length ? `⚠️ Bỏ qua: ${skipped.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // /bonguoitheodoi <callsign>
  async removePd(ctx, csArg) {
    if (!(await this.guard(ctx))) return;
    const cs = S(csArg);
    if (!cs) return ctx.reply('⚠️ Cú pháp: `/bonguoitheodoi <callsign>`');
    const { ws, rows } = await this.sheet(PD_TAB, PD_HEADER);
    const del = [];
    rows.forEach((r, i) => {
      if (i > 0 && S(r[0]).replace(/^'/, '') === cs) del.push(i + 1);
    });
    if (!del.length) return ctx.reply(`⚠️ Callsign **${cs}** không có trong danh sách người theo dõi.`);
    await ws.deleteRows(del);
    return ctx.reply(`✅ Đã bỏ **${cs}** khỏi danh sách người theo dõi.`);
  }

  // Danh sách theo dõi (cache 1 phút để mỗi dispatch không phải đọc sheet)
  async watchList(force = false) {
    if (!force && this.cache && Date.now() - this.cache.t < 60_000) return this.cache.list;
    const { rows } = await this.sheet();
    const list = new Map();
    rows.forEach((r, i) => {
      const momo = S(r[0]).replace(/^'/, '');
      if (i > 0 && /^\d+$/.test(momo)) list.set(momo, { note: S(r[1]), row: i + 1 });
    });
    this.cache = { list, t: Date.now() };
    return list;
  }

  // Mọi lệnh theo dõi: chỉ PD bot admin, và chỉ dùng trong room theo dõi
  async guard(ctx) {
    if (!isBotAdmin(ctx.author)) {
      await ctx.reply(NO_PERM);
      return false;
    }
    if (ctx.channel?.id !== ROOMS.THEO_DOI) {
      await ctx.reply(`⚠️ Lệnh này chỉ dùng trong <#${ROOMS.THEO_DOI}>.`);
      return false;
    }
    return true;
  }

  // /theodoi <momo> [ghi chú]
  async add(ctx, momoArg, note) {
    if (!(await this.guard(ctx))) return;
    const momo = S(momoArg);
    if (!/^\d+$/.test(momo)) return ctx.reply('⚠️ Cú pháp: `/theodoi <momo> [ghi chú]`. Ví dụ: `/theodoi 12345 nghi buôn hàng trắng`');
    const list = await this.watchList(true);
    if (list.has(momo)) return ctx.reply(`ℹ️ Momo **${momo}** đã có trong danh sách theo dõi.`);
    const { ws } = await this.sheet();
    await ws.appendRow([`'${momo}`, note ? `'${note}` : '', `'${ctx.author.displayName}`, `'${fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss')}`]);
    this.cache = null;
    return ctx.reply(`✅ Đã thêm momo **${momo}** vào danh sách theo dõi đặc biệt${note ? ` (${note})` : ''}.`);
  }

  // /botheodoi <momo>
  async remove(ctx, momoArg) {
    if (!(await this.guard(ctx))) return;
    const momo = S(momoArg);
    if (!/^\d+$/.test(momo)) return ctx.reply('⚠️ Cú pháp: `/botheodoi <momo>`');
    const { ws, rows } = await this.sheet();
    const del = [];
    rows.forEach((r, i) => {
      if (i > 0 && S(r[0]).replace(/^'/, '') === momo) del.push(i + 1);
    });
    if (!del.length) return ctx.reply(`⚠️ Momo **${momo}** không có trong danh sách theo dõi.`);
    await ws.deleteRows(del);
    this.cache = null;
    return ctx.reply(`✅ Đã bỏ momo **${momo}** khỏi danh sách theo dõi.`);
  }

  // /dstheodoi
  async list(ctx) {
    if (!(await this.guard(ctx))) return;
    const list = await this.watchList(true);
    const pds = await this.pdList();
    const csMap = await this.members(ctx.guild);
    const lines = [...list].map(([m, d], i) => `**${i + 1}.** ${m}${d.note ? ` — ${d.note}` : ''}`);
    const pdLines = pds.map((cs) => csMap.get(cs)?.displayName ?? `${cs} *(không thấy trên Discord)*`);
    const embed = new EmbedBuilder()
      .setTitle('👁️ Theo dõi đặc biệt')
      .setColor(0x992d22)
      .addFields(
        { name: `🎯 Đối tượng (${list.size})`, value: (lines.join('\n') || 'Trống — thêm bằng `/theodoi <momo> [ghi chú]`').slice(0, 1024) },
        { name: `👮 Người được tag khi có báo (${pds.length})`, value: (pdLines.join('\n') || 'Trống — thêm bằng `/themnguoitheodoi <callsign>`').slice(0, 1024) },
      )
      .setFooter({ text: `Dữ liệu: tab ${TAB}, ${PD_TAB} (GCPD DATA)` });
    return ctx.reply({ embeds: [embed] });
  }

  // Tag các PD trong danh sách người theo dõi (dò Discord theo callsign)
  async pdMentions(guild) {
    const csMap = await this.members(guild);
    return [...new Set((await this.pdList()).map((cs) => csMap.get(cs)?.toString()).filter(Boolean))];
  }

  async onMessage(message) {
    if (message.channel.id !== ROOMS.DISPATCH || !message.embeds.length || !ROOMS.THEO_DOI) return;
    const embed = message.embeds[0];
    const name = incidentNameOf(embed);
    if (!name || !isWatchedDispatch(name)) return;
    const momo = creatorIdOf(embed);
    if (!momo) return;

    const list = await this.watchList();
    const target = list.get(momo);
    if (!target) return;

    const key = `${momo}|${name.toLowerCase()}`;
    if (Date.now() - (this.lastAlert.get(key) ?? 0) < COOLDOWN_MS) return; // máy bay hay báo lặp
    this.lastAlert.set(key, Date.now());

    const ch = this.room();
    if (!ch) return console.error(`[TheoDoi] LỖI: không thấy room theo dõi ${ROOMS.THEO_DOI}`);
    const mentions = await this.pdMentions(ch.guild);

    const info = new EmbedBuilder()
      .setTitle('👁️ Đối tượng theo dõi đặc biệt')
      .setColor(0x992d22)
      .setDescription(
        [
          `**Momo:** ${momo}`,
          target.note ? `**Ghi chú:** ${target.note}` : '',
          `**Dispatch:** ${name}`,
          `**Thời gian:** ${fmt(toVN(message.createdAt), 'HH:mm:ss DD/MM/YYYY')}`,
          `**Log:** ${message.url}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .setFooter({ text: 'Dispatch System' });

    const head =
      `🚨 **Đối tượng theo dõi đặc biệt** (momo **${momo}**) đang làm **${name}**. Đề nghị theo dõi` +
      (mentions.length ? '' : ' *(chưa có người theo dõi — thêm bằng `/themnguoitheodoi <callsign>`)*');
    // Tin đầu kèm thông tin; tag quá dài thì chia thêm tin (giới hạn 2000 ký tự)
    const chunks = [];
    let cur = head;
    for (const m of mentions) {
      if (cur.length + m.length + 1 > 1900) {
        chunks.push(cur);
        cur = m;
      } else cur += ` ${m}`;
    }
    chunks.push(cur);
    await ch.send({ content: chunks[0], embeds: [info], allowedMentions: { parse: ['users'] } });
    for (const c of chunks.slice(1)) await ch.send({ content: c, allowedMentions: { parse: ['users'] } });
    console.log(`[TheoDoi] Momo ${momo} làm "${name}" -> báo ${mentions.length} người`);
  }
}
