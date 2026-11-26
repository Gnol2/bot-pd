import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Cog } from '../core/Cog.js';
import { UNG_TUYEN, BOT_ADMIN_ROLE, SHEET_IDS, ROOMS } from '../config.js';
import { COLORS, fmt, nowVN, isBotAdmin, hasRole, roleByName, removeAccents, sanitizeVal, NO_PERM, Mutex, S } from '../utils.js';

// ==========================================
// ĐƠN ỨNG TUYỂN PD (kiểu Ticket Tool)
// /ungtuyenpanel -> nút "Nộp đơn" -> form trang 1 -> form trang 2 -> xác nhận nội quy
// -> tạo kênh ticket riêng (ứng viên + ban tuyển dụng nhắn tin trao đổi) + ghi sheet tuyenpd
// -> FTO /nhanday (ghi tab Nhan-Day) -> dạy xong /bangiao (tag Sở, ghi giờ bàn giao) -> Sở đóng ticket
// Quyền đóng: chưa ai nhận dạy / đã bàn giao = FTO/Sở/admin · đang dạy = chỉ admin
// ==========================================

// 2 cột ID cuối để bot tìm lại dòng của ticket và nhận ra người dạy dù họ đổi nickname
const TEACH_HEADER = ['Tên HV', 'Người dạy', 'Thời gian nhận', 'Thời gian bàn giao', 'ID kênh ticket', 'ID người dạy'];
const C = { HV: 0, TEACHER: 1, TAKEN: 2, HANDED: 3, CHANNEL: 4, TEACHER_ID: 5 }; // vị trí cột tab Nhan-Day
const plainId = (v) => S(v).replace(/^'/, '');

const ID = 'ut'; // tiền tố customId của module
const SESSION_TTL = 30 * 60_000; // form dở dang giữ 30 phút
const TOPIC_RE = /ut:(\d+)/; // topic kênh ticket: "Đơn ứng tuyển PD · ut:<userId>"

// key = cột trong sheet tuyenpd (khớp theo tên header), long = ô nhập nhiều dòng
const PAGES = [
  [
    { key: 'Tên Ingame', label: 'Tên Ingame', max: 60 },
    { key: 'Số MoMo / ID InGame', label: 'Số MoMo / ID InGame', max: 20 },
    { key: 'Tuổi', label: 'Tuổi', max: 3 },
    { key: 'Giới tính', label: 'Giới tính', max: 10, placeholder: 'Nam / Nữ' },
    { key: 'Đã tham gia thành phố bao lâu', label: 'Đã tham gia thành phố bao lâu', max: 100 },
  ],
  [
    { key: 'Lý do ứng tuyển GCPD', label: 'Lý do ứng tuyển GCPD', long: true, max: 1000 },
    { key: 'Kinh nghiệm làm PD', label: 'Kinh nghiệm làm PD', long: true, max: 500 },
    { key: 'Kiến thức Roleplay / Non RP / CRM / MG', label: 'Kiến thức Roleplay / Non RP / CRM / MG', long: true, max: 1000 },
    { key: 'Thời gian trực khi vào PD', label: 'Thời gian trực khi vào PD', max: 100, placeholder: 'Vd: 20h-23h mỗi ngày' },
    { key: 'Đã tham gia Discord Gacha City', label: 'Đã tham gia Discord Gacha City chưa', max: 50 },
  ],
];
const FIELDS = PAGES.flat();

const normHeader = (s) => removeAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const btn = (id, label, style, emoji) => {
  const b = new ButtonBuilder().setCustomId(`${ID}:${id}`).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};
const row = (...b) => new ActionRowBuilder().addComponents(...b);
const eph = (content, components = []) => ({ content, components, flags: MessageFlags.Ephemeral });

export default class UngTuyen extends Cog {
  constructor(bot) {
    super(bot);
    this.sessions = new Map(); // userId -> { answers, t }
    this.creating = new Set(); // chống bấm nộp 2 lần
    this.teachLock = new Mutex(); // 2 FTO cùng /nhanday một lúc không ghi đè nhau
    this.commands = {
      ungtuyenpanel: (ctx) => this.postPanel(ctx),
      nhanday: (ctx) => this.nhanDay(ctx),
      bangiao: (ctx) => this.banGiao(ctx),
    };
    this.onInteraction = (i) =>
      this.handle(i).catch(async (e) => {
        console.error('[UngTuyen] LỖI xử lý:', e);
        if (i.isRepliable() && !i.replied && !i.deferred) await i.reply(eph(`❌ Lỗi: ${e.message}`)).catch(() => {});
      });
    bot.on(Events.InteractionCreate, this.onInteraction);
  }

  unload() {
    this.bot.off(Events.InteractionCreate, this.onInteraction);
    super.unload();
  }

  isFto(member) {
    return UNG_TUYEN.FTO_ROLES.some((r) => hasRole(member, r));
  }
  isSo(member) {
    return UNG_TUYEN.SO_ROLES.some((r) => hasRole(member, r));
  }

  findTicket(guild, userId) {
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildText && TOPIC_RE.exec(c.topic ?? '')?.[1] === userId) ?? null;
  }

  // ==========================================
  // /ungtuyenpanel — đặt bảng "Nộp đơn" vào kênh hiện tại (PD bot admin)
  // ==========================================
  async postPanel(ctx) {
    if (!isBotAdmin(ctx.author)) return ctx.reply(NO_PERM);
    const embed = new EmbedBuilder()
      .setTitle('📝 ỨNG TUYỂN GACHA POLICE DEPARTMENT')
      .setColor(COLORS.blue)
      .setDescription(
        'Bạn muốn trở thành **cảnh sát GCPD**? Bấm nút **Nộp đơn** bên dưới để điền đơn ứng tuyển.\n\n' +
          '**Quy trình**\n' +
          '1️⃣ Điền form (2 trang) và xác nhận đã đọc nội quy\n' +
          '2️⃣ Bot tạo **kênh riêng** giữa bạn và ban tuyển dụng\n' +
          '3️⃣ Ban tuyển dụng xem đơn, hẹn phỏng vấn và báo kết quả trong kênh đó\n\n' +
          '**Lưu ý**: mỗi người chỉ có **1 đơn đang mở**. Trả lời trung thực, đầy đủ.',
      )
      .setFooter({ text: 'Hệ thống Tuyển dụng GCPD' });
    await ctx.channel.send({ embeds: [embed], components: [row(btn('start', 'Nộp đơn', ButtonStyle.Success, '📝'))] });
    return ctx.reply('✅ Đã đặt bảng nộp đơn ứng tuyển vào kênh này.');
  }

  // ==========================================
  // ĐIỀU PHỐI INTERACTION (nút + form) — chỉ nhận customId "ut:..."
  // ==========================================
  async handle(i) {
    if (!(i.isButton() || i.isModalSubmit()) || !i.customId.startsWith(`${ID}:`) || !i.inGuild()) return;
    const [, action] = i.customId.split(':');

    if (i.isButton()) {
      if (action === 'start') return this.start(i);
      if (action === 'p2') return this.showPage(i, 1);
      if (action === 'submit') return this.submit(i);
      if (action === 'close') return this.close(i);
      // Nút Duyệt/Từ chối trên các ticket tạo trước khi bỏ tính năng này
      if (action === 'approve' || action === 'reject') {
        return i.reply(eph('ℹ️ Nút này không còn dùng. Trao đổi kết quả trực tiếp trong kênh, xong thì bấm **Đóng ticket**.'));
      }
    } else if (action === 'm0' || action === 'm1') {
      return this.savePage(i, Number(action[1]));
    }
  }

  getSession(userId) {
    const s = this.sessions.get(userId);
    if (!s || Date.now() - s.t > SESSION_TTL) {
      this.sessions.delete(userId);
      return null;
    }
    return s;
  }

  // Bấm "Nộp đơn"
  async start(i) {
    const open = this.findTicket(i.guild, i.user.id);
    if (open) return i.reply(eph(`⚠️ Bạn đang có đơn chưa xử lý xong: ${open}. Vui lòng chờ ban tuyển dụng phản hồi.`));
    this.sessions.set(i.user.id, { answers: {}, t: Date.now() });
    return this.showPage(i, 0);
  }

  async showPage(i, page) {
    const s = this.getSession(i.user.id);
    if (!s) return i.reply(eph('⌛ Form đã hết hạn (quá 30 phút) hoặc bot vừa khởi động lại. Bấm **Nộp đơn** để làm lại.'));
    const modal = new ModalBuilder().setCustomId(`${ID}:m${page}`).setTitle(`Đơn ứng tuyển GCPD (${page + 1}/2)`);
    for (const f of PAGES[page]) {
      const input = new TextInputBuilder()
        .setCustomId(f.key)
        .setLabel(f.label.slice(0, 45))
        .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(f.max);
      if (f.placeholder) input.setPlaceholder(f.placeholder);
      if (s.answers[f.key]) input.setValue(s.answers[f.key]); // giữ câu đã điền khi mở lại
      modal.addComponents(row(input));
    }
    return i.showModal(modal);
  }

  async savePage(i, page) {
    const s = this.getSession(i.user.id);
    if (!s) return i.reply(eph('⌛ Form đã hết hạn hoặc bot vừa khởi động lại. Bấm **Nộp đơn** để làm lại.'));
    for (const f of PAGES[page]) s.answers[f.key] = i.fields.getTextInputValue(f.key).trim();
    s.t = Date.now();

    if (page === 0) {
      return i.reply(eph('✅ Đã lưu **trang 1/2**. Bấm để điền tiếp trang 2.', [row(btn('p2', 'Điền trang 2', ButtonStyle.Primary, '➡️'))]));
    }
    // Sau trang 2 = xác nhận nội quy (thay cho câu "Đã đọc nội quy" của Google Form)
    return i.reply(
      eph(
        '📜 **Bước cuối**: xác nhận bạn **đã đọc và đồng ý tuân thủ nội quy GCPD**, rồi bấm nộp đơn.',
        [row(btn('submit', 'Tôi đã đọc nội quy — Nộp đơn', ButtonStyle.Success, '✅'), btn('p2', 'Sửa trang 2', ButtonStyle.Secondary, '✏️'))],
      ),
    );
  }

  // Bấm "Nộp đơn" cuối: tạo ticket + ghi sheet
  async submit(i) {
    const s = this.getSession(i.user.id);
    if (!s || FIELDS.some((f) => !s.answers[f.key])) {
      return i.reply(eph('⌛ Form đã hết hạn hoặc chưa điền đủ. Bấm **Nộp đơn** để làm lại.'));
    }
    if (this.creating.has(i.user.id)) return i.reply(eph('⏳ Đang tạo kênh, vui lòng chờ...'));
    const open = this.findTicket(i.guild, i.user.id);
    if (open) return i.reply(eph(`⚠️ Bạn đang có đơn chưa xử lý xong: ${open}.`));

    this.creating.add(i.user.id);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const answers = { ...s.answers, 'Đã đọc nội quy': 'Có' };
      const ch = await this.createTicket(i, answers);
      this.sessions.delete(i.user.id);
      await i.editReply({ content: `✅ Đã nộp đơn! Kênh của bạn: ${ch}`, components: [] });
      this.writeSheet(i, answers).catch((e) => console.error('[UngTuyen] LỖI ghi sheet tuyenpd:', e.message));
      console.log(`[UngTuyen] Đơn mới: ${i.user.tag} (${answers['Tên Ingame']}) -> #${ch.name}`);
    } catch (e) {
      console.error('[UngTuyen] LỖI tạo ticket:', e);
      const hint = e.code === 50013 ? ' (bot thiếu quyền **Quản lý kênh / Quản lý vai trò**)' : '';
      await i.editReply({ content: `❌ Không tạo được kênh đơn${hint}. Báo ban quản lý giúp nhé.`, components: [] });
    } finally {
      this.creating.delete(i.user.id);
    }
  }

  applicationEmbed(user, answers) {
    const e = new EmbedBuilder()
      .setTitle('📝 Hồ sơ ứng tuyển GCPD')
      .setColor(COLORS.green)
      .setThumbnail(user.displayAvatarURL())
      .setDescription(`Ứng viên: ${user} (\`${user.username}\` · ID \`${user.id}\`)\nNộp lúc: **${fmt(nowVN(), 'HH:mm DD/MM/YYYY')}**`)
      .setFooter({ text: 'Hệ thống Tuyển dụng GCPD' });
    for (const f of FIELDS) {
      e.addFields({ name: f.label, value: `\`\`\`\n${answers[f.key] || 'Không có'}\n\`\`\``.slice(0, 1024), inline: !f.long });
    }
    e.addFields({ name: 'Đã đọc nội quy', value: '```\nCó\n```', inline: true });
    return e;
  }

  async createTicket(i, answers) {
    const guild = i.guild;
    const panelParent = i.channel?.parentId ?? null;
    const parent = UNG_TUYEN.CATEGORY || panelParent;
    const reviewers = [...new Set([...UNG_TUYEN.FTO_ROLES, ...UNG_TUYEN.SO_ROLES, BOT_ADMIN_ROLE])]
      .map((n) => roleByName(guild, n))
      .filter(Boolean);

    const view = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
    const slug = removeAccents(answers['Tên Ingame']).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || i.user.username;

    const ch = await guild.channels.create({
      name: `ung-tuyen-${slug}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent,
      topic: `Đơn ứng tuyển PD · ut:${i.user.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: view },
        ...reviewers.map((r) => ({ id: r.id, allow: view })),
        { id: this.bot.user.id, allow: [...view, PermissionFlagsBits.ManageChannels] },
      ],
      reason: `Đơn ứng tuyển PD của ${i.user.tag}`,
    });

    await ch.send({
      content:
        `${i.user} ${reviewers.map((r) => r.toString()).join(' ')}\n📥 **Đơn ứng tuyển mới.** Ban tuyển dụng sẽ xem đơn và liên hệ bạn tại kênh này.\n` +
        `-# FTO nhận dạy: gõ \`/nhanday\` · Dạy xong: \`/bangiao\` để bàn giao cho Sở`,
      embeds: [this.applicationEmbed(i.user, answers)],
      components: [row(btn('close', 'Đóng ticket', ButtonStyle.Secondary, '🔒'))],
      allowedMentions: { users: [i.user.id], roles: reviewers.map((r) => r.id) },
    });
    return ch;
  }

  // Ghi 1 dòng vào tab tuyenpd, khớp cột theo tên header (form cũ)
  async writeSheet(i, answers) {
    const ws = this.bot.sheets.phongvan;
    if (!ws) return;
    const header = (await ws.getAllValues())[0] ?? [];
    const values = {
      'Thời gian nộp': fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss'),
      'Tên đăng nhập Discord': i.user.username,
      'ID Discord': `'${i.user.id}`, // giữ nguyên dạng chữ, không để Sheets làm tròn số dài
      ...answers,
    };
    const byNorm = new Map(Object.entries(values).map(([k, v]) => [normHeader(k), v]));
    const rowData = header.map((h) => (byNorm.has(normHeader(h)) ? sanitizeVal(String(byNorm.get(normHeader(h)))) : ''));
    if (!rowData.some(Boolean)) return console.error('[UngTuyen] Tab tuyenpd không có header khớp, bỏ qua ghi sheet');
    await ws.appendRow(rowData);
  }

  ticketInfo(channel) {
    const userId = TOPIC_RE.exec(channel?.topic ?? '')?.[1];
    return userId ? { userId } : null;
  }

  // ==========================================
  // NHẬN DẠY / BÀN GIAO (tab Nhan-Day, cột theo TEACH_HEADER)
  // ==========================================
  async teachSheet() {
    const [ws] = await this.bot.gs.ensureWorksheet(SHEET_IDS.PHONGVAN, UNG_TUYEN.TEACH_TAB, { cols: TEACH_HEADER.length });
    const rows = await ws.getAllValues();
    if (!rows.length || !S(rows[0][0])) {
      await ws.updateRange('A1', [TEACH_HEADER]);
      return { ws, rows: [TEACH_HEADER] };
    }
    return { ws, rows };
  }

  // Dòng nhận dạy của kênh ticket: { row (1-indexed), data } hoặc null
  findTeach(rows, channelId) {
    const idx = rows.findIndex((r, k) => k > 0 && plainId(r[C.CHANNEL]) === channelId);
    return idx === -1 ? null : { row: idx + 1, data: rows[idx] };
  }

  async teachState(channelId) {
    const { rows } = await this.teachSheet();
    return this.findTeach(rows, channelId);
  }

  // Tên HV = "Tên Ingame" trong hồ sơ (tin nhắn đầu của bot trong kênh), không có thì lấy tên Discord của ứng viên
  async hvName(channel, userId) {
    const msgs = await channel.messages.fetch({ after: '0', limit: 10 }).catch(() => null);
    const embed = msgs?.find((m) => m.author.id === this.bot.user.id && m.embeds[0]?.title?.includes('Hồ sơ ứng tuyển'))?.embeds[0];
    const f = embed?.fields?.find((x) => x.name === 'Tên Ingame');
    const name = f?.value?.replace(/```/g, '').trim();
    if (name) return name;
    const member = await channel.guild.members.fetch(userId).catch(() => null);
    return member?.displayName ?? userId;
  }

  async nhanDay(ctx) {
    const t = this.ticketInfo(ctx.channel);
    if (!t) return ctx.reply('⚠️ Lệnh này chỉ dùng trong kênh đơn ứng tuyển.');
    if (!this.isFto(ctx.author) && !this.isSo(ctx.author) && !isBotAdmin(ctx.author)) {
      return ctx.reply(`❌ Chỉ ${UNG_TUYEN.FTO_ROLES.join(', ')} (hoặc Sở / PD bot admin) mới nhận dạy được.`);
    }
    return this.teachLock.run(async () => {
      const { ws, rows } = await this.teachSheet();
      const cur = this.findTeach(rows, ctx.channel.id);
      if (cur) return ctx.reply(`⚠️ Học viên này đã được **${cur.data[C.TEACHER]}** nhận dạy lúc \`${cur.data[C.TAKEN]}\`.`);

      const hv = await this.hvName(ctx.channel, t.userId);
      const now = fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss');
      const line = [];
      line[C.HV] = sanitizeVal(hv);
      line[C.TEACHER] = sanitizeVal(ctx.author.displayName);
      line[C.TAKEN] = now;
      line[C.HANDED] = '';
      line[C.CHANNEL] = `'${ctx.channel.id}`; // dạng chữ, không để Sheets làm tròn ID dài
      line[C.TEACHER_ID] = `'${ctx.author.id}`;
      await ws.appendRow(line);
      console.log(`[UngTuyen] ${ctx.author.displayName} nhận dạy HV ${hv} (#${ctx.channel.name})`);
      return ctx.reply(
        `🎓 ${ctx.author} đã **nhận dạy** học viên **${hv}** <@${t.userId}> lúc \`${now}\`.\nDạy xong gõ \`/bangiao\` để bàn giao cho Sở.`,
      );
    });
  }

  async banGiao(ctx) {
    const t = this.ticketInfo(ctx.channel);
    if (!t) return ctx.reply('⚠️ Lệnh này chỉ dùng trong kênh đơn ứng tuyển.');
    return this.teachLock.run(async () => {
      const { ws, rows } = await this.teachSheet();
      const cur = this.findTeach(rows, ctx.channel.id);
      if (!cur) return ctx.reply('⚠️ Chưa ai nhận dạy học viên này. FTO gõ `/nhanday` trước.');
      if (S(cur.data[C.HANDED])) return ctx.reply(`⚠️ Đã bàn giao cho Sở lúc \`${cur.data[C.HANDED]}\`.`);
      if (plainId(cur.data[C.TEACHER_ID]) !== ctx.author.id && !isBotAdmin(ctx.author)) {
        return ctx.reply(`❌ Chỉ người nhận dạy (**${cur.data[C.TEACHER]}**) hoặc PD bot admin mới bàn giao được.`);
      }

      const now = fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss');
      await ws.updateCell(cur.row, C.HANDED + 1, now);
      const so = UNG_TUYEN.SO_ROLES.map((n) => roleByName(ctx.guild, n)).filter(Boolean);
      console.log(`[UngTuyen] ${ctx.author.displayName} bàn giao HV ${cur.data[C.HV]} cho Sở (#${ctx.channel.name})`);
      return ctx.reply(
        `📤 ${ctx.author} đã dạy xong và **bàn giao** học viên **${cur.data[C.HV]}** cho Sở lúc \`${now}\`.\n` +
          `${so.map((r) => r.toString()).join(' ') || UNG_TUYEN.SO_ROLES.join(', ')} vui lòng tiếp nhận, xong thì bấm **🔒 Đóng ticket**.`,
      );
    });
  }

  // ==========================================
  // ĐÓNG TICKET
  // Chưa ai nhận dạy / đã bàn giao: FTO / Sở / admin · Đang dạy (chưa bàn giao): chỉ admin
  // Đóng ticket đã bàn giao -> thông báo vào kênh BANGIAO (tag người dạy, học viên, Sở)
  // ==========================================
  async canClose(member, channelId) {
    const admin = isBotAdmin(member);
    const cur = await this.teachState(channelId);
    if (cur && !S(cur.data[C.HANDED])) {
      return admin
        ? { ok: true, cur }
        : { ok: false, why: `Học viên đang được **${cur.data[C.TEACHER]}** dạy. Người dạy gõ \`/bangiao\` xong mới đóng được.` };
    }
    return admin || this.isSo(member) || this.isFto(member)
      ? { ok: true, cur }
      : { ok: false, why: `Chỉ ${[...UNG_TUYEN.FTO_ROLES, ...UNG_TUYEN.SO_ROLES].join(', ')} hoặc PD bot admin mới đóng được.` };
  }

  async announceHandover(guild, cur, applicantId, closer) {
    const ch = this.bot.channels.cache.get(ROOMS.BANGIAO);
    if (!ch) return console.error('[UngTuyen] LỖI: không thấy kênh BANGIAO');
    const teacherId = plainId(cur.data[C.TEACHER_ID]);
    const so = UNG_TUYEN.SO_ROLES.map((n) => roleByName(guild, n)).filter(Boolean);
    const embed = new EmbedBuilder()
      .setTitle('📋 BÀN GIAO HỌC VIÊN')
      .setColor(COLORS.blue)
      .addFields(
        { name: '🕒 Thời gian bàn giao', value: `**${S(cur.data[C.HANDED])}**`, inline: true },
        { name: '🕒 Thời gian nhận dạy', value: S(cur.data[C.TAKEN]) || '?', inline: true },
        { name: '🎓 Học viên', value: `<@${applicantId}> · **${S(cur.data[C.HV])}**`, inline: false },
        { name: '👮 Người dạy bàn giao', value: teacherId ? `<@${teacherId}>` : `**${S(cur.data[C.TEACHER])}**`, inline: true },
        { name: '🔒 Đóng ticket', value: `${closer}`, inline: true },
      )
      .setFooter({ text: `Đóng lúc ${fmt(nowVN(), 'HH:mm DD/MM/YYYY')}` });
    const tags = [teacherId && `<@${teacherId}>`, `<@${applicantId}>`, ...so.map((r) => r.toString())].filter(Boolean);
    await ch
      .send({
        content: tags.join(' '),
        embeds: [embed],
        allowedMentions: { users: [teacherId, applicantId].filter(Boolean), roles: so.map((r) => r.id) },
      })
      .catch((e) => console.error('[UngTuyen] LỖI gửi thông báo bàn giao:', e.message));
  }

  async close(i) {
    const t = this.ticketInfo(i.channel);
    if (!t) return i.reply(eph('⚠️ Kênh này không còn là ticket ứng tuyển.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral }); // đọc sheet có thể quá 3 giây
    const check = await this.canClose(i.member, i.channel.id);
    if (!check.ok) return i.editReply(`❌ ${check.why}`);
    await i.editReply('🔒 Đang đóng ticket...');
    const { userId } = t;
    if (check.cur && S(check.cur.data[C.HANDED])) await this.announceHandover(i.guild, check.cur, userId, i.member);
    await i.channel.send(`🔒 Ticket sẽ đóng sau **5 giây** (bởi ${i.member}).`);
    console.log(`[UngTuyen] ${i.member.displayName} đóng đơn của ${userId} (#${i.channel.name})`);
    await this.sleep(5000);
    await i.channel.delete(`Đóng đơn ứng tuyển (${i.member.displayName})`).catch((e) => console.error('[UngTuyen] LỖI xoá kênh:', e.message));
  }
}
