import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { Cog } from '../core/Cog.js';
import { SHEET_IDS } from '../config.js';
import { S } from '../utils.js';

// Tra cứu file "Tội phạm phải đọc":
//   tab luatpd       : Nghề | Chi tiết nghề | Link     -> mã 1, 2, 3...
//   tab tricklobicam : STT - Liên quan | Nội dung     -> mã T1, T2...
//   !luat            -> danh sách + menu chọn, chọn mục nào bot trả chi tiết (chỉ người chọn thấy)
//   !luat <mã>       -> xem theo mã (vd: !luat 5, !luat t2)
//   !luat <từ khóa>  -> tìm theo tên/nội dung (không cần gõ dấu)
const SECTIONS = [
  { code: '', tab: 'luatpd', label: 'Luật nghề', icon: '📜', color: 0x2b6cb0 },
  { code: 'T', tab: 'tricklobicam', label: 'Trick lỏ bị cấm', icon: '🚫', color: 0xc53030 },
];
const CACHE_MS = 5 * 60_000;
const SELECT_ID = 'luat:select';
const ACRONYMS = ['PD', 'GCPD', 'UPD', 'ATM', 'DOC', 'GPLX', 'GPLMB', 'TTC', 'ANTT'];

const norm = (s) =>
  S(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ');

// "TRỘM CHÓ" -> "Trộm chó", "Trộm xe ( lockpick xe )" -> "Trộm xe (lockpick xe)", giữ PD/ATM/...
function prettyName(raw) {
  let s = S(raw).replace(/\s*:\s*$/, '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  const words = s.split(' ').filter((w) => /\p{L}/u.test(w));
  const allCaps = s === s.toUpperCase();
  const titleCase = words.length > 1 && words.every((w) => /^\P{L}*\p{Lu}/u.test(w));
  if (words.length && (allCaps || titleCase)) {
    s = s
      .split(' ')
      .map((w) => (ACRONYMS.includes(w.replace(/[^\p{L}-]/gu, '')) ? w : w.toLowerCase()))
      .join(' ');
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const boldLabel = (p) => {
  const t = /^(\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?(?:\s*trở đi)?)\s*:?\s*(.+)$/i.exec(p); // mốc giờ "00:00 - 00:59 : ..."
  if (t) return `**${t[1]}:** ${t[2]}`;
  const m = /^([^:]{1,32}?):\s*(.+)$/.exec(p);
  return m ? `**${cap(m[1])}:** ${m[2]}` : cap(p);
};
const sideIcon = (p) => (/^(criminal|crim|tội phạm)\b/i.test(p) ? '🔴' : /^(police|pd|gcpd)\b/i.test(p) ? '🔵' : '');

// Ô chi tiết có 2 kiểu:
//  - nhiều dòng (xuống dòng trong ô): dòng "- ..." là ý con, dòng ngắn không có "-" là tiêu đề nhóm
//  - một dòng "• ý 1 • ý 2" (kiểu cũ)
function formatDetail(raw) {
  const text = S(raw).replace(/\r/g, '');
  if (!text.includes('\n')) {
    return text
      .split('•')
      .map((p) => p.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .map((p) => `${sideIcon(p) || '▸'} ${boldLabel(p)}`)
      .join('\n');
  }
  const out = [];
  for (const line of text.split('\n')) {
    const l = line.trim().replace(/[ \t]+/g, ' ');
    if (!l) continue;
    const item = /^[-•–+*]\s*(.*)$/.exec(l);
    const note = /^(lưu ý|chú ý|ghi chú)\s*[:–-]?\s*(.*)$/i.exec(l);
    const ref = /^\(([^)]{1,30})\)\s*(.+)$/.exec(l); // "(40) Pistol khi ..." -> số hiệu ở cuối dòng
    if (ref) {
      out.push(`▸ ${boldLabel(ref[2])} \`#${ref[1]}\``);
    } else if (note) {
      if (out.length) out.push('');
      out.push(`⚠️ **Lưu ý:** ${note[2]}`);
    } else if (item && item[1].length <= 25 && item[1] === item[1].toUpperCase() && /\p{L}/u.test(item[1])) {
      if (out.length) out.push(''); // "- TIMINGS" -> tiêu đề nhóm
      out.push(`**${item[1]}**`);
    } else if (item) {
      if (item[1]) out.push(`▸ ${boldLabel(item[1])}`);
    } else if (/^\d{1,2}:\d{2}/.test(l)) {
      out.push(`▸ ${boldLabel(l)}`);
    } else if (l.length <= 45 && !/[.!]$/.test(l)) {
      // tiêu đề nhóm: Criminal / Police / Quy định bắt buộc / Cooldown: 30 phút...
      if (out.length) out.push('');
      const icon = sideIcon(l);
      out.push(`${icon ? icon + ' ' : ''}${/:\s*\S/.test(l) ? boldLabel(l) : `**${cap(l.replace(/:$/, ''))}**`}`);
    } else {
      out.push(cap(l));
    }
  }
  return out.join('\n');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export default class Luat extends Cog {
  constructor(bot) {
    super(bot);
    this.rules = []; // mọi mục của mọi tab
    this.loadedAt = 0;
    this.commands = { luat: (ctx, ...a) => this.cmdLuat(ctx, a) };
    this.onInteraction = (i) => this.handleInteraction(i).catch((e) => console.error('[Luat] LỖI xử lý menu:', e));
    bot.on(Events.InteractionCreate, this.onInteraction);
  }

  unload() {
    this.bot.off(Events.InteractionCreate, this.onInteraction);
    super.unload();
  }

  async readSection(sec) {
    const ws = await this.bot.gs.worksheet(SHEET_IDS.LUAT, sec.tab);
    const rows = await ws.getAllValues();
    // dòng tiêu đề: dòng đầu tiên có cả cột A và B (Nghề | Chi tiết, STT | Nội dung)
    const head = rows.findIndex((r) => S(r[0]) && S(r[1]));
    const out = [];
    for (const r of rows.slice(head + 1)) {
      const name = prettyName(S(r[0]).replace(/^\d+\s*[.)]?\s*[-–]?\s*/, '')); // "01. - VŨ KHÍ" -> "Vũ khí"
      const detail = S(r[1]);
      if (!name || !detail) continue;
      const no = out.length + 1;
      out.push({ sec, no, id: `${sec.code}${no}`, name, detail, link: S(r[2]), key: norm(name), text: norm(detail) });
    }
    return out;
  }

  async getRules(force = false) {
    if (!force && this.rules.length && Date.now() - this.loadedAt < CACHE_MS) return this.rules;
    const all = [];
    for (const sec of SECTIONS) {
      try {
        const items = await this.readSection(sec);
        sec.count = items.length;
        all.push(...items);
      } catch (e) {
        sec.count = 0;
        console.error(`[Luat] LỖI đọc tab ${sec.tab}:`, e.message);
      }
    }
    if (!all.length) throw new Error('không đọc được tab nào');
    this.rules = all;
    this.loadedAt = Date.now();
    return all;
  }

  find(id) {
    return this.rules.find((r) => r.id.toLowerCase() === String(id).toLowerCase());
  }

  ruleEmbed(r) {
    const e = new EmbedBuilder()
      .setColor(r.sec.color)
      .setTitle(clip(`${r.sec.icon} ${r.id}. ${r.name}`, 256))
      .setDescription(clip(formatDetail(r.detail), 4000))
      .setFooter({ text: `${r.sec.label} ${r.no}/${r.sec.count} • Gõ !luat để xem danh sách` });
    if (/^https?:\/\//.test(r.link)) e.setURL(r.link);
    return e;
  }

  linkRow(r) {
    if (!/^https?:\/\//.test(r.link)) return [];
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Xem bài gốc').setEmoji('🔗').setURL(r.link),
      ),
    ];
  }

  // Mỗi tab 1 hoặc nhiều menu (25 mục/menu), tổng tối đa 5 menu
  menus(list) {
    const rows = [];
    for (const sec of SECTIONS) {
      const items = list.filter((r) => r.sec === sec);
      for (let i = 0; i < items.length && rows.length < 5; i += 25) {
        const chunk = items.slice(i, i + 25);
        const range = chunk.length > 1 ? `${chunk[0].id}–${chunk[chunk.length - 1].id}` : chunk[0].id;
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`${SELECT_ID}:${rows.length}`)
          .setPlaceholder(`${sec.icon} ${sec.label} (${range})`)
          .addOptions(
            chunk.map((r) => ({
              label: clip(`${r.id}. ${r.name}`, 100),
              description: clip(r.detail.replace(/\(\s*[^)]{1,30}\)\s/g, '').replace(/[•\-–]\s/g, ' ').replace(/\s+/g, ' ').trim(), 100),
              value: r.id,
            })),
          );
        rows.push(new ActionRowBuilder().addComponents(menu));
      }
    }
    return rows;
  }

  listEmbed(list, title, note) {
    const blocks = [];
    for (const sec of SECTIONS) {
      const items = list.filter((r) => r.sec === sec);
      if (!items.length) continue;
      const w = Math.max(...items.map((r) => r.id.length), 2);
      blocks.push(`**${sec.icon} ${sec.label} (${items.length})**\n` + items.map((r) => `\`${r.id.padStart(w, '0')}\` ${r.name}`).join('\n'));
    }
    return new EmbedBuilder()
      .setColor(SECTIONS[0].color)
      .setTitle(title)
      .setDescription(clip(`${note}\n\n${blocks.join('\n\n')}`, 4000))
      .setFooter({ text: 'Nguồn: Tội phạm phải đọc • !luat <mã | từ khóa> để xem nhanh' });
  }

  async cmdLuat(ctx, args) {
    let rules;
    try {
      rules = await this.getRules(args[0] === 'reload');
    } catch (e) {
      return ctx.reply(`❌ Lỗi đọc sheet luật: ${e.message}`);
    }
    const q = args.filter((a) => a !== 'reload').join(' ').trim();

    if (!q) {
      return ctx.send({
        embeds: [this.listEmbed(rules, '📚 Luật GCPD', 'Chọn mục trong menu bên dưới để xem chi tiết.')],
        components: this.menus(rules),
      });
    }

    // Mã: 5, 05, t2, T02
    const code = /^([a-z]?)0*(\d+)$/i.exec(q);
    if (code) {
      const r = this.find(`${code[1]}${code[2]}`);
      if (!r) return ctx.reply(`📭 Không có mục **${q}**. Gõ \`!luat\` để xem danh sách.`);
      return ctx.send({ embeds: [this.ruleEmbed(r)], components: this.linkRow(r) });
    }

    const nq = norm(q);
    let found = rules.filter((r) => r.key.includes(nq));
    if (!found.length) {
      const words = nq.split(' ').filter((w) => w.length > 1);
      found = rules.filter((r) => words.every((w) => r.key.includes(w) || r.text.includes(w)));
    }
    if (!found.length) return ctx.reply(`📭 Không tìm thấy mục nào khớp **${q}**. Gõ \`!luat\` để xem danh sách.`);
    if (found.length === 1) {
      return ctx.send({ embeds: [this.ruleEmbed(found[0])], components: this.linkRow(found[0]) });
    }
    return ctx.send({
      embeds: [this.listEmbed(found, `🔎 ${found.length} mục khớp "${clip(q, 50)}"`, 'Chọn mục để xem chi tiết.')],
      components: this.menus(found),
    });
  }

  async handleInteraction(i) {
    if (!i.isStringSelectMenu() || !i.customId.startsWith(SELECT_ID)) return;
    await this.getRules();
    const r = this.find(i.values[0]);
    if (!r) {
      return i.reply({ content: '⚠️ Danh sách đã thay đổi, gõ lại `!luat`.', flags: MessageFlags.Ephemeral });
    }
    await i.reply({ embeds: [this.ruleEmbed(r)], components: this.linkRow(r), flags: MessageFlags.Ephemeral });
  }
}
