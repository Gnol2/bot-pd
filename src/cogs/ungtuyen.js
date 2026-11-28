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
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Cog } from '../core/Cog.js';
import { UNG_TUYEN, BOT_ADMIN_ROLE, SHEET_IDS, ROOMS } from '../config.js';
import {
  COLORS, fmt, nowVN, isBotAdmin, hasRole, roleByName, removeAccents, sanitizeVal, NO_PERM, Mutex, S, callsignOf,
} from '../utils.js';

// ==========================================
// ĐƠN ỨNG TUYỂN PD (kiểu Ticket Tool)
// /ungtuyenpanel -> nút "Nộp đơn" -> form trang 1 -> form trang 2 -> xác nhận nội quy
// -> tạo kênh ticket riêng (ứng viên + ban tuyển dụng nhắn tin trao đổi) + ghi sheet tuyenpd
// -> FTO /nhanday (ghi tab Nhan-Day) -> dạy xong /bangiao <momo>: momo phải là CSV trong GCPD HOME
//    -> báo Sở ở kênh BANGIAO (nhắc mỗi 30 phút) -> Sở /nhanbangiao -> đóng ticket. /dsbangiao xem danh sách.
// Quyền đóng: chưa ai nhận dạy / đã bàn giao = FTO/Sở/admin · đang dạy = chỉ admin
// Đóng = hỏi xác nhận -> khoá chat (giữ kênh) -> nút "Xoá ticket" chỉ PD bot admin bấm được
// ==========================================

// Cột tab Nhan-Day. Cột mới luôn thêm vào CUỐI để dữ liệu cũ không lệch.
// 2 cột ID để bot tìm lại dòng của ticket và nhận ra người dạy dù họ đổi nickname. Người dạy/nhận lưu bằng callsign.
const TEACH_HEADER = [
  'Tên HV', 'Người dạy', 'Thời gian nhận dạy', 'Thời gian bàn giao', 'ID kênh ticket', 'ID người dạy',
  'Momo CSV', 'Người nhận bàn giao', 'Thời gian nhận bàn giao',
];
const C = { HV: 0, TEACHER: 1, TAKEN: 2, HANDED: 3, CHANNEL: 4, TEACHER_ID: 5, MOMO: 6, RECEIVER: 7, RECEIVED: 8 };
const plainId = (v) => S(v).replace(/^'/, '');
const nowText = () => fmt(nowVN(), 'DD/MM/YYYY HH:mm:ss');
const csOf = (member) => callsignOf(member.displayName) || member.displayName;
// "27/11/2026 01:33:58" (giờ VN) -> mốc thời gian thật (ms), không đọc được -> null
const parseVNTime = (s) => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(S(s));
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0)) - 7 * 3600_000 : null;
};

const ID = 'ut'; // tiền tố customId của module
const SESSION_TTL = 30 * 60_000; // form dở dang giữ 30 phút
const TOPIC_RE = /ut:(\d+)/; // topic kênh ticket ĐANG MỞ: "Đơn ứng tuyển PD · ut:<userId>"
const CLOSED_RE = /utc:(\d+)/; // topic ticket ĐÃ ĐÓNG (khoá chat, chờ admin xoá): "... · utc:<userId>"
// Quyền bị gỡ khi đóng ticket: không ai nhắn / thả react / tạo thread được nữa (vẫn xem lại được lịch sử)
const LOCK_PERMS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.AttachFiles,
];

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

// Điều khoản ứng viên phải đồng ý ở bước cuối trước khi nộp đơn (mỗi mục 1 field, tối đa 1024 ký tự/field)
const TERMS = [
  [
    '🔹 Từ khi bắt đầu làm Học Viên',
    'Trong vòng **2 tuần** kể từ ngày gia nhập lực lượng GCPD làm học viên **BẮT BUỘC PHẢI HOÀN THÀNH KHÓA HỌC** và thi đậu lên Cảnh Sát Viên. ' +
      'Nếu trong khoảng thời gian này **không hoàn thành khóa học và không thi đậu lên làm Cảnh Sát Viên**, **TỰ Ý RỜI NGÀNH** hoặc viết **ĐƠN XIN RỜI NGÀNH** ' +
      'lập tức sẽ bị phạt Ticket hóa đơn **500.000 IC** (bắt buộc phải thanh toán trong vòng 24h) và **Blacklist toàn ngành**. ' +
      'Học viên vắng mặt 3 ngày không xin phép, không có buổi học nào sẽ bị phạt Ticket hóa đơn **100.000 IC** (thanh toán trong vòng 24h). ' +
      'Bị phạt nhưng không thanh toán trong vòng 24 giờ thì phía Cảnh Sát sẽ gởi qua Tòa Thị Chính xử lý.',
  ],
  [
    '🔹 Khi đã là Học Viên',
    'Mỗi khi vào thành phố sẽ phải trình diện tại **Trụ Sở PD 723** hoặc **Trụ sở PD 217** để gặp Giảng Viên và học. ' +
      'Nếu không có Giảng Viên trong thời gian đó thì phải ở đồn PD 723 hỗ trợ người dân hoặc có thể đi theo Cảnh sát viên khác học hỏi ' +
      '(tuyệt đối không tham gia bất cứ tình huống nào khi đi chung với CSV - không xuống xe tham gia tình huống). ' +
      '**Tuyệt đối không thử và sử dụng bất cứ chức năng ngành nào đối với bất kì ai, không lái xe ngành với mọi lý do.**',
  ],
  [
    '🔹 Khi đã là Học Viên',
    'Trong thời gian là học viên không được làm nghề bẩn, đi đánh chém hỗ trợ các GANG, chỉ được cho phép tham gia Thính. ' +
      'Khi bận OC phải Offduty và cởi đồ học viên ra, bận làm việc riêng không học phải Offduty. ' +
      'Phải dành trọn thời gian khi vào Thành phố chỉ để học và thi lên Cảnh Sát viên trong thời gian nhanh nhất có thể (có thể hoàn thành khóa học trong 1 ngày).',
  ],
  [
    '🔹 Khi đã là Cảnh Sát Viên',
    'Phải phục vụ ngành ít nhất **2 tuần** kể từ lúc chính thức làm Cảnh Sát Viên, rời ngành sớm hoặc không làm việc trong thời gian 2 tuần này ' +
      'sẽ bị phạt **500.000 IC** (bắt buộc phải thanh toán trong vòng 24h) và **Blacklist toàn ngành**. ' +
      'Khi Offduty không làm nghề bẩn (trừ Cướp Biển Báo - nếu bị bắt phạt x2), không mặc đồ thường lái xe ngành, không mặc đồ ngành lái xe thường, ' +
      'không sử dụng xe ngành cho mục đích cá nhân, không treo Duty. ' +
      'Khi Offduty: tuyệt đối không sử dụng bất cứ chức năng ngành nào với bất kì ai, không mặc đồ ngành, không sử dụng quân tư trang của ngành trong mọi tình huống. ' +
      '**Bắt buộc phải có Bodycam khi tham gia bất kì tình huống nào.**',
  ],
];
const termsEmbed = () =>
  new EmbedBuilder()
    .setTitle('📖 TUYỆT ĐỐI TUÂN THỦ & THỎA THUẬN CHẤP HÀNH')
    .setColor(COLORS.red)
    .setDescription('Học viên đã được nhận vào làm việc tại Sở Cảnh sát Thành phố Gacha tức là đã đồng ý với các điều kiện sau:')
    .addFields(TERMS.map(([name, value]) => ({ name, value, inline: false })));

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
    this.lastRemind = new Map(); // ID kênh ticket -> lần nhắc bàn giao gần nhất (ms)
    this.commands = {
      ungtuyenpanel: (ctx) => this.postPanel(ctx),
      nhanday: (ctx) => this.nhanDay(ctx),
      bangiao: (ctx, momo, code) => this.banGiao(ctx, momo, code),
      nhanbangiao: (ctx, momo) => this.nhanBanGiao(ctx, momo),
      dsbangiao: (ctx) => this.dsBanGiao(ctx),
    };
    // Bàn giao chưa ai nhận -> nhắc Sở trong kênh BANGIAO mỗi REMIND_MIN phút (kiểm tra mỗi 5 phút)
    this.loop('bangiao_remind', 5 * 60_000, () => this.remindPending(), { before: () => this.sleep(60_000) });
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
      if (action === 'closeyes') return this.confirmClose(i);
      if (action === 'closeno') return i.update({ content: '↩️ Đã huỷ, ticket vẫn mở.', components: [] });
      if (action === 'delete') return this.deleteTicket(i);
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
    // Sau trang 2 = đọc điều khoản + xác nhận đồng ý (thay cho câu "Đã đọc nội quy" của Google Form)
    return i.reply({
      ...eph(
        '📜 **Bước cuối**: đọc kỹ điều khoản bên dưới. Bấm nộp đơn nghĩa là bạn **đã đọc và đồng ý tuân thủ** toàn bộ điều khoản.',
        [row(btn('submit', 'Tôi đã đọc & đồng ý — Nộp đơn', ButtonStyle.Success, '✅'), btn('p2', 'Sửa trang 2', ButtonStyle.Secondary, '✏️'))],
      ),
      embeds: [termsEmbed()],
    });
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
      .setDescription(`Ứng viên: ${user} \nNộp lúc: **${fmt(nowVN(), 'HH:mm DD/MM/YYYY')}**`)
      .setFooter({ text: 'Hệ thống Tuyển dụng GCPD' });
    // Mỗi thông tin 1 dòng riêng (không xếp cột). hvName() đọc lại field "Tên Ingame" nên giữ đúng tên field.
    for (const f of FIELDS) {
      e.addFields({ name: f.label, value: (answers[f.key] || 'Không có').slice(0, 1024), inline: false });
    }
    e.addFields({ name: 'Đã đọc nội quy', value: 'Có', inline: false });
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

    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'); // mã đơn 6 số ngẫu nhiên
    const ch = await guild.channels.create({
      name: `${code}-${slug}`.slice(0, 90),
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
        `${i.user} ${reviewers.map((r) => r.toString()).join(' ')}\n📥 **Đơn ứng tuyển mới.** Ban tuyển dụng sẽ xem đơn và liên hệ bạn tại kênh này.\n`,
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
    if (!this.teachSized) {
      await ws.ensureSize(1, TEACH_HEADER.length); // tab cũ ít cột hơn -> nới thêm cột mới (1 lần mỗi lần bật bot)
      this.teachSized = true;
    }
    const rows = await ws.getAllValues();
    // Tab mới hoặc header cũ (ít cột) -> ghi header đầy đủ, dữ liệu bên dưới giữ nguyên
    if (!rows.length || !S(rows[0][0]) || S(rows[0][TEACH_HEADER.length - 1]) !== TEACH_HEADER.at(-1)) {
      await ws.updateRange('A1', [TEACH_HEADER]);
      if (rows.length) rows[0] = [...TEACH_HEADER];
      else rows.push([...TEACH_HEADER]);
    }
    return { ws, rows };
  }

  // Bàn giao đang chờ Sở nhận (có momo CSV, chưa ai /nhanbangiao)
  pendingHandovers(rows) {
    const out = [];
    rows.forEach((r, k) => {
      if (k > 0 && S(r[C.HANDED]) && S(r[C.MOMO]) && !S(r[C.RECEIVED])) out.push({ row: k + 1, data: r });
    });
    return out;
  }

  soRoles(guild) {
    return UNG_TUYEN.SO_ROLES.map((n) => roleByName(guild, n)).filter(Boolean);
  }

  // Tra momo trong data GCPD HOME (B callsign, C momo, D tên, E chức vụ)
  async lookupData(momo) {
    const rows = await this.bot.sheets.role.getAllValues();
    const matches = rows.filter((r) => S(r[2]) === momo);
    const csv = matches.find((r) => UNG_TUYEN.CSV_RANKS.includes(S(r[4]).toUpperCase()));
    const info = (r) => r && { cs: S(r[1]), name: S(r[3]), rank: S(r[4]) };
    return { csv: info(csv), any: info(matches.at(-1)) };
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

  // Thông tin HV từ hồ sơ (tin nhắn đầu của bot trong kênh):
  // name = "Tên Ingame" (không có thì tên Discord), momo = số trong "Số MoMo / ID InGame" (không có -> '')
  async hvInfo(channel, userId) {
    const msgs = await channel.messages.fetch({ after: '0', limit: 10 }).catch(() => null);
    const embed = msgs?.find((m) => m.author.id === this.bot.user.id && m.embeds[0]?.title?.includes('Hồ sơ ứng tuyển'))?.embeds[0];
    const field = (n) => embed?.fields?.find((x) => x.name === n)?.value?.replace(/```/g, '').trim() ?? '';
    const momo = /\d+/.exec(field('Số MoMo / ID InGame'))?.[0] ?? '';
    let name = field('Tên Ingame');
    if (!name) {
      const member = await channel.guild.members.fetch(userId).catch(() => null);
      name = member?.displayName ?? userId;
    }
    return { name, momo };
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

      const { name: hv, momo } = await this.hvInfo(ctx.channel, t.userId);
      const now = nowText();
      const line = Array(TEACH_HEADER.length).fill('');
      line[C.HV] = sanitizeVal(hv);
      line[C.MOMO] = momo ? `'${momo}` : ''; // momo trong hồ sơ, /bangiao dùng luôn số này
      line[C.TEACHER] = `'${csOf(ctx.author)}`; // lưu callsign, dạng chữ để giữ số 0 đầu (vd "01")
      line[C.TAKEN] = `'${now}`; // dạng chữ, Sheets không tự đổi ngày/tháng
      line[C.CHANNEL] = `'${ctx.channel.id}`; // dạng chữ, không để Sheets làm tròn ID dài
      line[C.TEACHER_ID] = `'${ctx.author.id}`;
      await ws.appendRow(line);
      console.log(`[UngTuyen] ${ctx.author.displayName} nhận dạy HV ${hv} (#${ctx.channel.name})`);
      return ctx.reply(
        `🎓 ${ctx.author} đã **nhận dạy** học viên **${hv}**${momo ? ` (momo **${momo}**)` : ''} <@${t.userId}> lúc \`${now}\`.\n` +
          `Dạy xong, cập nhật học viên lên **CSV** trong data rồi gõ \`/bangiao${momo ? ` ${momo}` : ' <momo>'}\` trong <#${ROOMS.BANGIAO}> để bàn giao cho Sở.`,
      );
    });
  }

  // /bangiao, /nhanbangiao chỉ dùng trong kênh BANGIAO
  async guardBangiaoRoom(ctx) {
    if (ctx.channel?.id === ROOMS.BANGIAO) return true;
    await ctx.reply(`⚠️ Lệnh này chỉ dùng trong <#${ROOMS.BANGIAO}>.`);
    return false;
  }

  // Mã đơn = 6 số đầu tên kênh đơn (vd "174118-nguyen-van-a"); kênh đã xoá/kênh cũ -> null
  ticketCode(channelId) {
    return /^(\d{6})-/.exec(this.bot.channels.cache.get(channelId)?.name ?? '')?.[1] ?? null;
  }

  // /bangiao [momo] [mã đơn] trong kênh BANGIAO: chọn HV người gõ đang dạy
  //  - momo bỏ trống = dùng momo đã lưu lúc /nhanday; có momo thì chọn đúng HV có momo đó
  //  - nhiều HV không phân biệt được thì cần mã đơn
  // momo phải đã là CSV trong GCPD HOME -> ghi giờ bàn giao + thông báo tag Sở ngay tại kênh BANGIAO
  async banGiao(ctx, momoArg, codeArg) {
    if (!(await this.guardBangiaoRoom(ctx))) return;
    const momoIn = S(momoArg);
    if (momoIn && !/^\d+$/.test(momoIn)) {
      return ctx.reply('⚠️ Cú pháp: `/bangiao [momo] [mã đơn]`. Ví dụ: `/bangiao`, `/bangiao 12345` hoặc `/bangiao 12345 174118`');
    }
    const code = S(codeArg);
    const codeChannel = /^<#(\d+)>$/.exec(code)?.[1] ?? (/^\d{17,20}$/.test(code) ? code : null); // nhận cả #kênh / ID kênh

    return this.teachLock.run(async () => {
      const { ws, rows } = await this.teachSheet();
      const admin = isBotAdmin(ctx.author);
      // HV đang dạy (đã /nhanday, chưa bàn giao) của người gõ; admin thấy tất cả
      let cands = [];
      rows.forEach((r, k) => {
        if (k > 0 && S(r[C.HV]) && !S(r[C.HANDED]) && (admin || plainId(r[C.TEACHER_ID]) === ctx.author.id)) cands.push({ row: k + 1, data: r });
      });
      if (code) {
        cands = cands.filter((c) => {
          const ch = plainId(c.data[C.CHANNEL]);
          return codeChannel ? ch === codeChannel : this.ticketCode(ch) === code;
        });
      } else if (momoIn) {
        // Có momo: ưu tiên HV có đúng momo đã lưu (không ai khớp thì giữ nguyên danh sách)
        const same = cands.filter((c) => plainId(c.data[C.MOMO]) === momoIn);
        if (same.length) cands = same;
      }
      if (!cands.length) {
        return ctx.reply(
          code
            ? `⚠️ Không tìm thấy học viên mã đơn **${code}** mà bạn đang dạy (chưa bàn giao).`
            : '⚠️ Bạn chưa nhận dạy học viên nào (hoặc đã bàn giao hết). FTO gõ `/nhanday` trong kênh đơn trước.',
        );
      }
      if (cands.length > 1) {
        const list = cands
          .map((c) => {
            const ch = plainId(c.data[C.CHANNEL]);
            const m = plainId(c.data[C.MOMO]);
            return `• **${S(c.data[C.HV])}**${m ? ` — momo **${m}**` : ''} — mã đơn **${this.ticketCode(ch) ?? '?'}** <#${ch}>${admin ? ` (dạy: ${S(c.data[C.TEACHER])})` : ''}`;
          })
          .join('\n');
        return ctx.reply(`⚠️ Đang dạy **${cands.length}** học viên, gõ \`/bangiao <momo>\` hoặc \`/bangiao <momo> <mã đơn>\`:\n${list}`.slice(0, 1900));
      }
      const cur = cands[0];
      const teacherId = plainId(cur.data[C.TEACHER_ID]);
      const ticketId = plainId(cur.data[C.CHANNEL]);
      const momo = momoIn || plainId(cur.data[C.MOMO]);
      if (!momo) {
        return ctx.reply(`⚠️ Hồ sơ của **${S(cur.data[C.HV])}** không có momo. Gõ \`/bangiao <momo>\` (momo của CSV mới).`);
      }

      // Kiểm tra data: momo đã lên CSV chưa
      const { csv, any } = await this.lookupData(momo);
      if (!csv) {
        const now = any ? `đang là **${any.rank || 'trống'}**` : 'chưa có trong data';
        return ctx.reply(
          `⚠️ <@${teacherId}> Momo **${momo}** ${now} (cần **${UNG_TUYEN.CSV_RANKS.join('/')}** trong GCPD HOME).\n` +
            `Vui lòng **cập nhật thông tin cho CSV mới** (momo **${momo}**) rồi gõ lại \`/bangiao ${momo}\`.`,
        );
      }

      const now = nowText();
      await ws.updateCells([
        { row: cur.row, col: C.HANDED + 1, value: `'${now}` },
        { row: cur.row, col: C.MOMO + 1, value: `'${momo}` },
      ]);
      this.lastRemind.set(ticketId, Date.now());
      console.log(`[UngTuyen] ${ctx.author.displayName} bàn giao CSV mới ${csv.name} (momo ${momo}) cho Sở`);

      return ctx.reply(
        this.handoverPayload(ctx.guild, { momo, csv, hv: S(cur.data[C.HV]), teacherId, teacherCs: S(cur.data[C.TEACHER]), at: now, channelId: ticketId }),
      );
    });
  }

  // Thông báo bàn giao (tag Sở) để gửi trong kênh BANGIAO
  handoverPayload(guild, h) {
    const so = this.soRoles(guild);
    const embed = new EmbedBuilder()
      .setTitle('📋 BÀN GIAO CẢNH SÁT VIÊN MỚI')
      .setColor(COLORS.blue)
      .addFields(
        { name: '🆔 Momo', value: `**${h.momo}**`, inline: true },
        { name: '👤 Tên ingame', value: `**${h.csv.name || h.hv}**`, inline: true },
        { name: '📟 Callsign', value: h.csv.cs ? `**${h.csv.cs}**` : '?', inline: true },
        { name: '👮 Người dạy bàn giao', value: `<@${h.teacherId}> (${h.teacherCs})`, inline: true },
        { name: '🕒 Thời gian bàn giao', value: `**${h.at}**`, inline: true },
        { name: '📁 Kênh đơn', value: `<#${h.channelId}>`, inline: true },
      )
      .setFooter({ text: `Sở gõ /nhanbangiao ${h.momo} để nhận bàn giao` });
    return {
      content: `${so.map((r) => r.toString()).join(' ')} vui lòng **nhận bàn giao cảnh sát viên mới**.`,
      embeds: [embed],
      allowedMentions: { roles: so.map((r) => r.id) },
    };
  }

  // /nhanbangiao [momo] trong kênh BANGIAO: Sở nhận bàn giao -> ghi callsign + thời gian nhận
  async nhanBanGiao(ctx, momoArg) {
    if (!(await this.guardBangiaoRoom(ctx))) return;
    if (!this.isSo(ctx.author) && !isBotAdmin(ctx.author)) {
      return ctx.reply(`❌ Chỉ ${UNG_TUYEN.SO_ROLES.join(', ')} hoặc PD bot admin mới nhận bàn giao được.`);
    }
    const momo = S(momoArg);
    return this.teachLock.run(async () => {
      const { ws, rows } = await this.teachSheet();
      const pending = this.pendingHandovers(rows);
      let target = null;
      if (momo) target = pending.find((p) => plainId(p.data[C.MOMO]) === momo);
      else if (pending.length === 1) target = pending[0];

      if (!target) {
        if (!pending.length) return ctx.reply('📭 Không có bàn giao nào đang chờ nhận.');
        const list = pending.map((p) => `• momo **${plainId(p.data[C.MOMO])}** — ${S(p.data[C.HV])} (bàn giao \`${S(p.data[C.HANDED])}\`)`).join('\n');
        return ctx.reply(
          `${momo ? `⚠️ Không có bàn giao đang chờ của momo **${momo}**.\n` : ''}Đang chờ nhận (${pending.length}), gõ \`/nhanbangiao <momo>\`:\n${list}`.slice(0, 1900),
        );
      }

      const now = nowText();
      await ws.updateCells([
        { row: target.row, col: C.RECEIVER + 1, value: `'${csOf(ctx.author)}` }, // callsign, dạng chữ
        { row: target.row, col: C.RECEIVED + 1, value: `'${now}` },
      ]);
      const channelId = plainId(target.data[C.CHANNEL]);
      const teacherId = plainId(target.data[C.TEACHER_ID]);
      const tMomo = plainId(target.data[C.MOMO]);
      this.lastRemind.delete(channelId);
      console.log(`[UngTuyen] ${ctx.author.displayName} nhận bàn giao momo ${tMomo}`);

      return ctx.reply(
        `✅ ${ctx.author} đã **nhận bàn giao** CSV mới **${S(target.data[C.HV])}** (momo **${tMomo}**) từ ${teacherId ? `<@${teacherId}>` : `**${S(target.data[C.TEACHER])}**`} lúc \`${now}\`.`,
      );
    });
  }

  // Nhắc Sở trong kênh BANGIAO mỗi REMIND_MIN phút cho bàn giao chưa ai nhận
  async remindPending() {
    const ch = this.bot.channels.cache.get(ROOMS.BANGIAO);
    if (!ch) return;
    const { rows } = await this.teachSheet();
    const every = UNG_TUYEN.REMIND_MIN * 60_000;
    const so = this.soRoles(ch.guild);
    for (const p of this.pendingHandovers(rows)) {
      const key = plainId(p.data[C.CHANNEL]) || `row${p.row}`;
      const handedAt = parseVNTime(p.data[C.HANDED]);
      if (!handedAt && !this.lastRemind.has(key)) continue;
      // Chưa nhớ lần nhắc nào (vd vừa restart) -> lấy mốc nhắc gần nhất theo lịch giờ bàn giao + N x REMIND_MIN,
      // để restart không nhắc ngay mà chờ tới mốc kế tiếp
      if (!this.lastRemind.has(key)) this.lastRemind.set(key, handedAt + Math.floor((Date.now() - handedAt) / every) * every);
      if (Date.now() - this.lastRemind.get(key) < every) continue;
      const mins = handedAt ? Math.round((Date.now() - handedAt) / 60_000) : '?';
      const momo = plainId(p.data[C.MOMO]);
      await ch
        .send({
          content:
            `⏰ **Nhắc bàn giao** ${so.map((r) => r.toString()).join(' ')}\n` +
            `CSV mới **${S(p.data[C.HV])}** (momo **${momo}**) do **${S(p.data[C.TEACHER])}** bàn giao lúc \`${S(p.data[C.HANDED])}\` ` +
            `(**${mins} phút** trước) vẫn **chưa ai nhận**. Gõ \`/nhanbangiao ${momo}\`.`,
          allowedMentions: { roles: so.map((r) => r.id) },
        })
        .catch((e) => console.error('[UngTuyen] LỖI nhắc bàn giao:', e.message));
      this.lastRemind.set(key, Date.now());
    }
  }

  // /dsbangiao: đang dạy, chờ Sở nhận, đã nhận gần đây
  async dsBanGiao(ctx) {
    if (!this.isFto(ctx.author) && !this.isSo(ctx.author) && !isBotAdmin(ctx.author)) {
      return ctx.reply(`❌ Chỉ ${[...UNG_TUYEN.FTO_ROLES, ...UNG_TUYEN.SO_ROLES].join(', ')} hoặc PD bot admin mới xem được.`);
    }
    const { rows } = await this.teachSheet();
    const data = rows.slice(1).filter((r) => S(r[C.HV]));
    const teaching = data.filter((r) => !S(r[C.HANDED]));
    const pending = this.pendingHandovers(rows).map((p) => p.data);
    const done = data.filter((r) => S(r[C.RECEIVED])).slice(-10).reverse();
    const ago = (t) => {
      const at = parseVNTime(t);
      return at ? ` · ${Math.round((Date.now() - at) / 60_000)} phút` : '';
    };
    const block = (lines, empty) => (lines.length ? lines.join('\n') : empty).slice(0, 1024);

    const embed = new EmbedBuilder()
      .setTitle('📋 Danh sách bàn giao CSV mới')
      .setColor(COLORS.blue)
      .addFields(
        {
          name: `⏳ Chờ Sở nhận (${pending.length})`,
          value: block(pending.map((r) => `• **${S(r[C.HV])}** (momo ${plainId(r[C.MOMO])}) — **${S(r[C.TEACHER])}** bàn giao \`${S(r[C.HANDED])}\`${ago(r[C.HANDED])}`), '*Không có*'),
        },
        {
          name: `🎓 Đang dạy (${teaching.length})`,
          value: block(teaching.map((r) => `• **${S(r[C.HV])}** (momo ${plainId(r[C.MOMO])}) — **${S(r[C.TEACHER])}** nhận dạy từ \`${S(r[C.TAKEN])}\``), '*Không có*'),
        },
        {
          name: `✅ Đã nhận bàn giao (10 gần nhất)`,
          value: block(done.map((r) => `• **${S(r[C.HV])}** (momo ${plainId(r[C.MOMO])}) — **${S(r[C.TEACHER])}** → **${S(r[C.RECEIVER])}** \`${S(r[C.RECEIVED])}\``), '*Chưa có*'),
        },
      )
      .setFooter({ text: `Dữ liệu: tab ${UNG_TUYEN.TEACH_TAB}` });
    return ctx.reply({ embeds: [embed] });
  }

  // ==========================================
  // ĐÓNG TICKET
  // Chưa ai nhận dạy / đã bàn giao: FTO / Sở / admin · Đang dạy (chưa bàn giao): chỉ admin
  // (Thông báo kênh BANGIAO gửi lúc /bangiao; đóng ticket không ảnh hưởng việc Sở /nhanbangiao)
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

  // Bấm "Đóng ticket" -> kiểm tra quyền -> hỏi xác nhận (chỉ người bấm thấy)
  async close(i) {
    if (CLOSED_RE.test(i.channel?.topic ?? '')) return i.reply(eph('ℹ️ Ticket này đã đóng. PD bot admin bấm **Xoá ticket** để xoá kênh.'));
    if (!this.ticketInfo(i.channel)) return i.reply(eph('⚠️ Kênh này không còn là ticket ứng tuyển.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral }); // đọc sheet có thể quá 3 giây
    const check = await this.canClose(i.member, i.channel.id);
    if (!check.ok) return i.editReply(`❌ ${check.why}`);
    return i.editReply({
      content: '❓ **Bạn có chắc chắn muốn đóng ticket này không?**\nĐóng xong kênh sẽ bị **khoá chat** (không ai nhắn được nữa), kênh vẫn được giữ lại.',
      components: [row(btn('closeyes', 'Có, đóng ticket', ButtonStyle.Danger, '🔒'), btn('closeno', 'Không', ButtonStyle.Secondary))],
    });
  }

  // Bấm "Có" -> khoá chat kênh (giữ kênh) + gửi nút "Xoá ticket" cho PD bot admin
  async confirmClose(i) {
    const t = this.ticketInfo(i.channel);
    if (!t) return i.update({ content: 'ℹ️ Ticket này đã được đóng rồi.', components: [] });
    await i.deferUpdate();
    const check = await this.canClose(i.member, i.channel.id); // kiểm tra lại, phòng trạng thái đổi trong lúc chờ bấm
    if (!check.ok) return i.editReply({ content: `❌ ${check.why}`, components: [] });

    // Gỡ quyền nhắn tin của mọi người/role trong kênh (trừ bot), giữ quyền xem lịch sử
    const overwrites = i.channel.permissionOverwrites.cache.map((ow) =>
      ow.id === this.bot.user.id
        ? { id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield }
        : {
            id: ow.id,
            type: ow.type,
            allow: new PermissionsBitField(ow.allow).remove(LOCK_PERMS).bitfield,
            deny: new PermissionsBitField(ow.deny).add(LOCK_PERMS).bitfield,
          },
    );
    try {
      await i.channel.edit({
        permissionOverwrites: overwrites,
        topic: `Đơn ứng tuyển PD (đã đóng) · utc:${t.userId}`, // ứng viên được nộp đơn mới
        reason: `Đóng đơn ứng tuyển (${i.member.displayName})`,
      });
    } catch (e) {
      console.error('[UngTuyen] LỖI khoá kênh:', e.message);
      const hint = e.code === 50013 ? ' (bot thiếu quyền **Quản lý kênh / Quản lý quyền**)' : '';
      return i.editReply({ content: `❌ Không khoá được kênh${hint}.`, components: [] });
    }

    await i.editReply({ content: '✅ Đã đóng ticket.', components: [] });
    const embed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setDescription(`🔒 **Ticket đã đóng** bởi ${i.member}\nThời gian: **${fmt(nowVN(), 'HH:mm DD/MM/YYYY')}**\nKênh đã khoá chat. PD bot admin bấm **Xoá ticket** để xoá kênh.`);
    await i.channel.send({ embeds: [embed], components: [row(btn('delete', 'Xoá ticket', ButtonStyle.Danger, '🗑️'))] });
    console.log(`[UngTuyen] ${i.member.displayName} đóng (khoá) đơn của ${t.userId} (#${i.channel.name})`);
  }

  // Bấm "Xoá ticket" -> chỉ PD bot admin -> xoá kênh
  async deleteTicket(i) {
    if (!isBotAdmin(i.member)) return i.reply(eph(`❌ Chỉ **${BOT_ADMIN_ROLE}** mới xoá được ticket.`));
    if (!CLOSED_RE.test(i.channel?.topic ?? '')) return i.reply(eph('⚠️ Ticket chưa đóng, bấm **Đóng ticket** trước.'));
    await i.reply(`🗑️ Ticket sẽ bị xoá sau **5 giây** (bởi ${i.member}).`);
    console.log(`[UngTuyen] ${i.member.displayName} xoá kênh #${i.channel.name}`);
    await this.sleep(5000);
    await i.channel.delete(`Xoá đơn ứng tuyển (${i.member.displayName})`).catch((e) => console.error('[UngTuyen] LỖI xoá kênh:', e.message));
  }
}
