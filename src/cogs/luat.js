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

// Tra cứu luật "Tội phạm phải đọc" (tab luatpd: Nghề | Chi tiết nghề | Link)
//   !luat            -> danh sách luật + menu chọn, chọn luật nào bot trả chi tiết luật đó (chỉ người chọn thấy)
//   !luat <số>       -> xem luật theo số thứ tự
//   !luat <từ khóa>  -> tìm theo tên/nội dung (không cần gõ dấu)
const TAB = 'luatpd';
const CACHE_MS = 5 * 60_000;
const SELECT_ID = 'luat:select';
const COLOR = 0x2b6cb0;
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

// "• Criminal: ... • PD: ..." -> các dòng, in đậm nhãn đầu dòng
function formatDetail(raw) {
  const parts = S(raw)
    .split('•')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return parts
    .map((p) => {
      const icon = /^criminal\b/i.test(p) ? '🔴' : /^p[dD]\b|^GCPD\b/.test(p) ? '🔵' : '▸';
      const m = /^([^:]{1,32}?):\s*(.+)$/.exec(p);
      const body = m ? `**${m[1].charAt(0).toUpperCase() + m[1].slice(1)}:** ${m[2]}` : p.charAt(0).toUpperCase() + p.slice(1);
      return `${icon} ${body}`;
    })
    .join('\n');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export default class Luat extends Cog {
  constructor(bot) {
    super(bot);
    this.rules = [];
    this.loadedAt = 0;
    this.commands = { luat: (ctx, ...a) => this.cmdLuat(ctx, a) };
    this.onInteraction = (i) => this.handleInteraction(i).catch((e) => console.error('❌ [luat.interaction]', e));
    bot.on(Events.InteractionCreate, this.onInteraction);
  }

  unload() {
    this.bot.off(Events.InteractionCreate, this.onInteraction);
    super.unload();
  }

  async getRules(force = false) {
    if (!force && this.rules.length && Date.now() - this.loadedAt < CACHE_MS) return this.rules;
    const ws = await this.bot.gs.worksheet(SHEET_IDS.LUAT, TAB);
    const rows = await ws.getAllValues();
    const head = rows.findIndex((r) => norm(r[0]) === 'nghe');
    const rules = [];
    for (const r of rows.slice(head + 1)) {
      const name = prettyName(r[0]);
      const detail = S(r[1]);
      if (!name || !detail) continue;
      rules.push({ no: rules.length + 1, name, detail, link: S(r[2]), key: norm(name), text: norm(detail) });
    }
    this.rules = rules;
    this.loadedAt = Date.now();
    return rules;
  }

  ruleEmbed(r, total) {
    const e = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(clip(`📜 ${r.no}. ${r.name}`, 256))
      .setDescription(clip(formatDetail(r.detail), 4000))
      .setFooter({ text: `Luật ${r.no}/${total} • Gõ !luat để xem danh sách` });
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

  // Tối đa 5 menu x 25 luật
  menus(list) {
    const rows = [];
    for (let i = 0; i < list.length && rows.length < 5; i += 25) {
      const chunk = list.slice(i, i + 25);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${SELECT_ID}:${rows.length}`)
        .setPlaceholder(`📖 Chọn luật ${chunk[0].no}–${chunk[chunk.length - 1].no}`)
        .addOptions(
          chunk.map((r) => ({
            label: clip(`${r.no}. ${r.name}`, 100),
            description: clip(r.detail.replace(/•/g, '').trim(), 100),
            value: String(r.no),
          })),
        );
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
    return rows;
  }

  listEmbed(list, title, note) {
    const lines = list.map((r) => `\`${String(r.no).padStart(2, '0')}\` ${r.name}`);
    return new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(title)
      .setDescription(clip(`${note}\n\n${lines.join('\n')}`, 4000))
      .setFooter({ text: 'Nguồn: Tội phạm phải đọc • !luat <từ khóa> để tìm nhanh' });
  }

  async cmdLuat(ctx, args) {
    let rules;
    try {
      rules = await this.getRules(args[0] === 'reload');
    } catch (e) {
      return ctx.reply(`❌ Lỗi đọc sheet luật: ${e.message}`);
    }
    if (!rules.length) return ctx.reply('📭 Sheet luật đang trống.');
    const q = args.filter((a) => a !== 'reload').join(' ').trim();

    if (!q) {
      return ctx.send({
        embeds: [this.listEmbed(rules, `📚 Luật GCPD (${rules.length})`, 'Chọn luật trong menu bên dưới để xem chi tiết.')],
        components: this.menus(rules),
      });
    }

    if (/^\d+$/.test(q)) {
      const r = rules[parseInt(q, 10) - 1];
      if (!r) return ctx.reply(`📭 Không có luật số **${q}** (có ${rules.length} luật).`);
      return ctx.send({ embeds: [this.ruleEmbed(r, rules.length)], components: this.linkRow(r) });
    }

    const nq = norm(q);
    let found = rules.filter((r) => r.key.includes(nq));
    if (!found.length) {
      const words = nq.split(' ').filter((w) => w.length > 1);
      found = rules.filter((r) => words.every((w) => r.key.includes(w) || r.text.includes(w)));
    }
    if (!found.length) return ctx.reply(`📭 Không tìm thấy luật nào khớp **${q}**. Gõ \`!luat\` để xem danh sách.`);
    if (found.length === 1) {
      return ctx.send({ embeds: [this.ruleEmbed(found[0], rules.length)], components: this.linkRow(found[0]) });
    }
    return ctx.send({
      embeds: [this.listEmbed(found, `🔎 ${found.length} luật khớp "${clip(q, 50)}"`, 'Chọn luật để xem chi tiết.')],
      components: this.menus(found),
    });
  }

  async handleInteraction(i) {
    if (!i.isStringSelectMenu() || !i.customId.startsWith(SELECT_ID)) return;
    const rules = await this.getRules();
    const r = rules[parseInt(i.values[0], 10) - 1];
    if (!r) {
      return i.reply({ content: '⚠️ Danh sách luật đã thay đổi, gõ lại `!luat`.', flags: MessageFlags.Ephemeral });
    }
    await i.reply({ embeds: [this.ruleEmbed(r, rules.length)], components: this.linkRow(r), flags: MessageFlags.Ephemeral });
  }
}
