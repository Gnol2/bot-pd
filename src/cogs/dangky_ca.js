import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, SHEET_IDS, BOT_ADMIN_ROLE } from '../config.js';
import { S, nowVN, addMs, DAY_MS, HOUR_MS, startOfDay, weekday, fmt, parseDMY, hasRole, callsignOf, COLORS, isBotAdmin, NO_PERM } from '../utils.js';

// ==========================================
// ĐĂNG KÝ CA TRỰC
// - 12 ca/ngày, mỗi ca 2 tiếng (Ca 1 = 00:00-02:00 ... Ca 12 = 22:00-24:00, giờ VN)
// - Mỗi PD tối đa 2 ca/ngày, mỗi ca tối đa 2 người
// - Chỉ PD có trong tab Online (nhận diện theo callsign trên nickname)
// - Dữ liệu: tab "Dang-Ky-Ca" (log); bảng xem: tab "Lich-Truc" (7 ngày tới, bot tự vẽ lại)
// ==========================================

const DATA_TAB = 'Dang-Ky-Ca';
const VIEW_TAB = 'Lich-Truc';
const NUM_CA = 12;
const CA_HOURS = 2;
const MAX_CA_PER_DAY = 2;
const MAX_PER_CA = 2;
const DAYS_AHEAD = 6; // hôm nay + 6 ngày
const ACTIVE = 'Đã đăng ký';
const CANCELLED = 'Đã hủy';
const HEADERS = ['Ngày', 'Ca', 'Khung giờ', 'Callsign', 'Momo', 'Tên Sĩ Quan', 'Thời gian đăng ký', 'Trạng thái', 'Discord ID', 'Ghi chú'];
const THU = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const REMIND_AFTER_MIN = 10; // ca bắt đầu được 10 phút mà chưa onduty thì nhắc
const REMIND_WINDOW_MIN = 30; // chỉ nhắc trong 30 phút sau mốc trên (bot tắt lâu hơn thì bỏ qua)
const REMINDED = 'Đã nhắc';

const p2 = (n) => String(n).padStart(2, '0');
export const caLabel = (ca) => `${p2((ca - 1) * CA_HOURS)}:00-${p2(ca * CA_HOURS)}:00`;
const dayKey = (d) => fmt(d, 'DD/MM/YYYY');
const dayShort = (d) => `${THU[weekday(d)]} ${fmt(d, 'DD/MM')}`;

// "3" | "4-6" | "4h-6h" | "04:00-06:00" -> số ca (1..12), sai trả null
export function parseCa(tok) {
  const t = S(tok).toLowerCase().replace(/^ca/, '');
  if (/^\d{1,2}$/.test(t)) {
    const n = +t;
    return n >= 1 && n <= NUM_CA ? n : null;
  }
  const m = /^(\d{1,2})(?:h|:00)?-(\d{1,2})(?:h|:00)?$/.exec(t);
  if (!m) return null;
  const a = +m[1];
  const b = +m[2] === 0 ? 24 : +m[2];
  if (a % CA_HOURS !== 0 || b - a !== CA_HOURS || b > 24) return null;
  return a / CA_HOURS + 1;
}

// "dd/mm" | "dd/mm/yyyy" | "mai" | "nay" -> ngày (giờ VN, 00:00); sai trả null; không phải ngày trả undefined
export function parseDay(tok, today) {
  const t = S(tok).toLowerCase();
  if (t === 'nay' || t === 'homnay') return today;
  if (t === 'mai') return addMs(today, DAY_MS);
  if (!/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(t)) return undefined;
  if (t.split('/').length === 3) return parseDMY(t);
  let d = parseDMY(`${t}/${today.getUTCFullYear()}`);
  if (d && d < today) d = parseDMY(`${t}/${today.getUTCFullYear() + 1}`) ?? d; // 30/12 -> 02/01 năm sau
  return d;
}

export default class DangKyCa extends Cog {
  constructor(bot) {
    super(bot);
    this._lock = Promise.resolve();
    this.onlineCache = null;
    this.onlineCacheTime = 0;
    this.commands = {
      dangky: (ctx, ...a) => this.dangKy(ctx, a),
      huyca: (ctx, ...a) => this.huyCa(ctx, a),
      lichtruc: (ctx, a) => this.lichTruc(ctx, a),
      cacuatoi: (ctx) => this.caCuaToi(ctx),
      xoaca: (ctx, ...a) => this.xoaCa(ctx, a),
      help: (ctx) => this.help(ctx),
      helpca: (ctx) => this.help(ctx, true),
    };
    // Vẽ lại bảng khi khởi động, mỗi 6 tiếng và ngay sau 00:00 VN (lăn cửa sổ 7 ngày)
    this.loop('lichtruc_refresh', 6 * HOUR_MS, () => this.renderView());
    this.dailyAtUTC('lichtruc_daily', 17, 1, () => this.renderView());
    // Nhắc PD đã đăng ký ca nhưng chưa onduty
    this.loop('ca_truc_reminder', 60_000, () => this.remindNotOnDuty());
  }

  // ---------- Nhắc khi đến ca mà chưa onduty ----------
  async remindNotOnDuty() {
    const now = nowVN();
    const minIntoCa = (now.getUTCHours() % CA_HOURS) * 60 + now.getUTCMinutes();
    if (minIntoCa < REMIND_AFTER_MIN || minIntoCa >= REMIND_AFTER_MIN + REMIND_WINDOW_MIN) return; // ngoài khung nhắc -> khỏi gọi API

    const ca = Math.floor(now.getUTCHours() / CA_HOURS) + 1;
    const key = dayKey(startOfDay(now));
    const ws = await this.dataSheet();
    const due = (await this.activeRows(ws)).filter((r) => r.day === key && r.ca === ca && !r.note.includes(REMINDED));
    if (!due.length) return;

    // Đọc trạng thái Duty mới nhất (cột H tab Online, do log_nhansu cập nhật)
    const online = await this.bot.sheets.online.getAllValues();
    const onDuty = new Set(online.filter((r) => S(r[7]).toLowerCase().includes('onduty')).map((r) => S(r[2])));
    const absent = due.filter((r) => !onDuty.has(r.momo));
    const stamp = fmt(now, 'HH:mm');

    if (absent.length) {
      const text =
        `⚠️ **Ca ${ca}** \`${caLabel(ca)}\` đã bắt đầu **${minIntoCa}** phút, chưa onduty:\n` +
        absent.map((r) => `• ${r.uid ? `<@${r.uid}>` : ''} **${r.cs} | ${r.name}**`).join('\n') +
        `\nVào ca hoặc báo quản lý nếu không trực được.`;
      const ch = ROOMS.DANG_KY_CA ? this.bot.channels.cache.get(ROOMS.DANG_KY_CA) : null;
      if (ch) {
        await ch.send({ content: text, allowedMentions: { users: absent.map((r) => r.uid).filter(Boolean) } });
      } else {
        // Chưa cấu hình kênh -> nhắn riêng từng người
        for (const r of absent) {
          if (!r.uid) continue;
          const user = await this.bot.users.fetch(r.uid).catch(() => null);
          const dm =
            `⚠️ **Ca ${ca}** \`${caLabel(ca)}\` ngày **${key}** đã bắt đầu **${minIntoCa}** phút, bạn chưa onduty.\n` +
            'Vào ca hoặc báo quản lý nếu không trực được.';
          await user?.send(dm).catch((e) => console.error(`❌ [NhacCa] Không DM được ${r.cs}:`, e.message));
        }
      }
      console.log(`⏰ [NhacCa] Ca ${ca} ${key}: nhắc ${absent.length} người chưa onduty.`);
    }

    // Đánh dấu đã xử lý cả người vắng (đã nhắc) lẫn người đã onduty, để không kiểm tra lại
    await ws.updateCells(
      due.map((r) => ({ row: r.row, col: 10, value: [r.note, onDuty.has(r.momo) ? `Có mặt ${stamp} (${REMINDED})` : `${REMINDED} ${stamp} - chưa onduty`].filter(Boolean).join('; ') })),
      'RAW',
    );
  }

  // Chạy tuần tự các thao tác ghi để 2 người bấm cùng lúc không vượt giới hạn
  withLock(fn) {
    const p = this._lock.then(fn, fn);
    this._lock = p.catch(() => {});
    return p;
  }

  inRoom(ctx) {
    return !ROOMS.DANG_KY_CA || ctx.channel.id === ROOMS.DANG_KY_CA;
  }

  isAdmin(member) {
    return isBotAdmin(member);
  }

  // ---------- Dữ liệu ----------
  async dataSheet() {
    const [ws, created] = await this.bot.gs.ensureWorksheet(SHEET_IDS.MAIN, DATA_TAB, { cols: HEADERS.length });
    if (created) {
      await ws.updateRange('A1', [HEADERS]);
      await ws.batch([boldRow(ws.sheetId, 0, HEADERS.length, '#1F3864')]);
    }
    return ws;
  }

  // Danh sách PD từ tab Online: callsign -> { cs, momo, name } (cache 5 phút)
  async officers() {
    if (this.onlineCache && Date.now() - this.onlineCacheTime < 300_000) return this.onlineCache;
    const rows = await this.bot.sheets.online.getAllValues();
    const map = new Map();
    for (const r of rows) {
      const cs = S(r[1]);
      const momo = S(r[2]);
      if (cs && /^\d+$/.test(momo) && !map.has(cs)) map.set(cs, { cs, momo, name: S(r[3]) });
    }
    this.onlineCache = map;
    this.onlineCacheTime = Date.now();
    return map;
  }

  async findOfficer(member) {
    const map = await this.officers();
    return map.get(callsignOf(member.displayName)) ?? null;
  }

  // Các dòng còn hiệu lực: [{ row (1-indexed), day, ca, cs, momo, name, uid }]
  async activeRows(ws) {
    const rows = await ws.getAllValues();
    const out = [];
    rows.forEach((r, i) => {
      if (i === 0 || S(r[7]) !== ACTIVE) return;
      const ca = parseInt(S(r[1]), 10);
      if (!S(r[0]) || !(ca >= 1 && ca <= NUM_CA)) return;
      out.push({ row: i + 1, day: S(r[0]), ca, cs: S(r[3]), momo: S(r[4]), name: S(r[5]), uid: S(r[8]), note: S(r[9]) });
    });
    return out;
  }

  // Đọc tham số: các số ca + 1 ngày (tuỳ chọn). Trả { cas, day } hoặc { error }
  parseArgs(args, maxCa) {
    const today = startOfDay(nowVN());
    let day = today;
    const cas = [];
    for (const a of args.filter(Boolean)) {
      const d = parseDay(a, today);
      if (d === null) return { error: `❌ Ngày \`${a}\` không hợp lệ. Dùng \`dd/mm\`, \`dd/mm/yyyy\` hoặc \`mai\`.` };
      if (d) {
        day = d;
        continue;
      }
      const ca = parseCa(a);
      if (!ca) return { error: `❌ Ca \`${a}\` không hợp lệ. Dùng số ca \`1\`–\`${NUM_CA}\` hoặc khung giờ chẵn như \`14-16\`.` };
      if (!cas.includes(ca)) cas.push(ca);
    }
    if (cas.length > maxCa) return { error: `❌ Mỗi lần chỉ được chọn tối đa ${maxCa} ca.` };
    const diff = Math.round((day - today) / DAY_MS);
    if (diff < 0 || diff > DAYS_AHEAD) {
      return { error: `❌ Chỉ đăng ký/hủy được từ hôm nay đến ${fmt(addMs(today, DAYS_AHEAD * DAY_MS), 'DD/MM')}.` };
    }
    return { cas, day };
  }

  caStart = (day, ca) => addMs(day, (ca - 1) * CA_HOURS * HOUR_MS);
  caEnd = (day, ca) => addMs(day, ca * CA_HOURS * HOUR_MS);

  // ---------- !dangky <ca> [ca2] [ngày] ----------
  async dangKy(ctx, args) {
    if (!this.inRoom(ctx)) return;
    const p = this.parseArgs(args, MAX_CA_PER_DAY);
    if (p.error) return ctx.reply(p.error);
    if (!p.cas.length) {
      return ctx.reply(`⚠️ Cú pháp: \`!dangky <ca> [ca 2] [ngày]\`\nVí dụ: \`!dangky 8\`, \`!dangky 14-16 20-22 mai\`, \`!dangky 3 18/11\` (xem ca trống: \`!lichtruc\`)`);
    }

    const me = await this.findOfficer(ctx.author);
    if (!me) return ctx.reply(`❌ Không tìm thấy callsign **${callsignOf(ctx.author.displayName)}** trong danh sách PD (tab Online). Liên hệ quản lý.`);

    return this.withLock(async () => {
      const ws = await this.dataSheet();
      const key = dayKey(p.day);
      const active = (await this.activeRows(ws)).filter((r) => r.day === key);
      const mine = active.filter((r) => r.momo === me.momo);
      const now = nowVN();

      const errors = [];
      const ok = [];
      for (const ca of p.cas) {
        if (this.caEnd(p.day, ca) <= now) errors.push(`Ca ${ca} (${caLabel(ca)}) đã kết thúc.`);
        else if (mine.some((r) => r.ca === ca)) errors.push(`Bạn đã đăng ký Ca ${ca} rồi.`);
        else if (active.filter((r) => r.ca === ca).length >= MAX_PER_CA) errors.push(`Ca ${ca} (${caLabel(ca)}) đã đủ ${MAX_PER_CA} người.`);
        else ok.push(ca);
      }
      if (mine.length + ok.length > MAX_CA_PER_DAY) {
        const left = MAX_CA_PER_DAY - mine.length;
        return ctx.reply(
          `❌ Tối đa **${MAX_CA_PER_DAY}** ca/ngày. Ngày **${key}** bạn đã có: ${mine.map((r) => `Ca ${r.ca}`).join(', ') || 'chưa có'} → còn đăng ký được **${Math.max(0, left)}** ca.`,
        );
      }
      if (!ok.length) return ctx.reply(`❌ Không đăng ký được:\n• ${errors.join('\n• ')}`);

      const stamp = fmt(now, 'DD/MM/YYYY HH:mm:ss');
      await ws.appendRows(
        ok.map((ca) => [key, ca, caLabel(ca), me.cs, me.momo, me.name, stamp, ACTIVE, ctx.author.id, '']),
        'RAW',
      );
      await this.renderView().catch((e) => console.error('❌ [DangKyCa] Lỗi vẽ Lich-Truc:', e.message));

      let msg = `✅ Đã đăng ký cho **${me.cs} | ${me.name}** ngày **${key}**: ${ok.map((ca) => `**Ca ${ca}** (${caLabel(ca)})`).join(', ')}.`;
      if (errors.length) msg += `\nKhông đăng ký được:\n• ${errors.join('\n• ')}`;
      return ctx.reply(msg);
    });
  }

  // ---------- !huyca <ca> [ngày] ----------
  async huyCa(ctx, args) {
    if (!this.inRoom(ctx)) return;
    const p = this.parseArgs(args, MAX_CA_PER_DAY);
    if (p.error) return ctx.reply(p.error);
    if (!p.cas.length) return ctx.reply('⚠️ Cú pháp: `!huyca <ca> [ngày]`\nVí dụ: `!huyca 8`, `!huyca 14-16 mai`');

    const me = await this.findOfficer(ctx.author);
    if (!me) return ctx.reply('❌ Bạn không có trong danh sách PD (tab Online).');

    return this.withLock(async () => {
      const ws = await this.dataSheet();
      const key = dayKey(p.day);
      const mine = (await this.activeRows(ws)).filter((r) => r.day === key && r.momo === me.momo);
      const now = nowVN();
      const cells = [];
      const done = [];
      const errors = [];
      for (const ca of p.cas) {
        const r = mine.find((x) => x.ca === ca);
        if (!r) errors.push(`Bạn chưa đăng ký Ca ${ca} ngày ${key}.`);
        else if (this.caStart(p.day, ca) <= now) errors.push(`Ca ${ca} đã bắt đầu, không tự hủy được (nhờ quản lý dùng \`!xoaca\`).`);
        else {
          cells.push({ row: r.row, col: 8, value: CANCELLED }, { row: r.row, col: 10, value: `Tự hủy ${fmt(now, 'DD/MM HH:mm')}` });
          done.push(ca);
        }
      }
      if (cells.length) {
        await ws.updateCells(cells, 'RAW');
        await this.renderView().catch((e) => console.error('❌ [DangKyCa] Lỗi vẽ Lich-Truc:', e.message));
      }
      let msg = done.length ? `✅ Đã hủy ${done.map((c) => `**Ca ${c}**`).join(', ')} ngày **${key}**.` : '';
      if (errors.length) msg += msg ? `\nKhông hủy được:\n• ${errors.join('\n• ')}` : `❌ Không hủy được:\n• ${errors.join('\n• ')}`;
      return ctx.reply(msg);
    });
  }

  // ---------- !xoaca <callsign|momo> <ca> [ngày] (quản lý) ----------
  async xoaCa(ctx, args) {
    if (!this.inRoom(ctx)) return;
    if (!this.isAdmin(ctx.author)) return ctx.reply(NO_PERM);
    const [who, ...rest] = args.filter(Boolean);
    const p = this.parseArgs(rest, NUM_CA);
    if (!who || p.error || !p.cas.length) {
      return ctx.reply(p.error ?? '⚠️ Cú pháp: `!xoaca <callsign|momo> <ca> [ngày]`\nVí dụ: `!xoaca 609 8 mai`');
    }
    return this.withLock(async () => {
      const ws = await this.dataSheet();
      const key = dayKey(p.day);
      const hits = (await this.activeRows(ws)).filter((r) => r.day === key && p.cas.includes(r.ca) && (r.cs === who || r.momo === who));
      if (!hits.length) return ctx.reply(`📭 **${who}** không đăng ký ${p.cas.map((c) => `Ca ${c}`).join(', ')} ngày **${key}**.`);
      const note = `Xóa bởi ${callsignOf(ctx.author.displayName)} ${fmt(nowVN(), 'DD/MM HH:mm')}`;
      await ws.updateCells(hits.flatMap((r) => [{ row: r.row, col: 8, value: CANCELLED }, { row: r.row, col: 10, value: note }]), 'RAW');
      await this.renderView().catch((e) => console.error('❌ [DangKyCa] Lỗi vẽ Lich-Truc:', e.message));
      return ctx.reply(`✅ Đã xóa ${hits.map((r) => `Ca ${r.ca}`).join(', ')} của **${hits[0].cs} | ${hits[0].name}** ngày **${key}**.`);
    });
  }

  // ---------- !lichtruc [ngày] ----------
  async lichTruc(ctx, dayArg) {
    if (!this.inRoom(ctx)) return;
    const today = startOfDay(nowVN());
    const day = dayArg ? parseDay(dayArg, today) : today;
    if (!day) return ctx.reply('❌ Ngày không hợp lệ. Ví dụ: `!lichtruc mai`, `!lichtruc 18/11`');

    const ws = await this.dataSheet();
    const key = dayKey(day);
    const active = (await this.activeRows(ws)).filter((r) => r.day === key);
    const now = nowVN();
    const lines = [];
    for (let ca = 1; ca <= NUM_CA; ca++) {
      const ppl = active.filter((r) => r.ca === ca);
      const names = ppl.map((r) => `${r.cs} ${r.name}`).join(', ');
      const free = MAX_PER_CA - ppl.length;
      const ended = this.caEnd(day, ca) <= now;
      const icon = ended ? '⚫' : free === 0 ? '🔴' : free === MAX_PER_CA ? '🟢' : '🟡';
      lines.push(`${icon} **Ca ${ca}** \`${caLabel(ca)}\` — ${names || '_trống_'}${!ended && free > 0 && ppl.length ? ` _(còn ${free})_` : ''}`);
    }
    const embed = new EmbedBuilder()
      .setTitle(`🗓️ Lịch ca trực ${dayShort(day)}/${day.getUTCFullYear()}`)
      .setColor(COLORS.blue)
      .setDescription(`${lines.join('\n')}\n\n🟢 trống · 🟡 còn chỗ · 🔴 đủ người · ⚫ đã qua\nĐăng ký: \`!dangky <ca> [ca 2] [ngày]\` · Hủy: \`!huyca <ca> [ngày]\``)
      .setFooter({ text: `Tối đa ${MAX_CA_PER_DAY} ca/người/ngày · ${MAX_PER_CA} người/ca` });
    return ctx.reply({ embeds: [embed] });
  }

  // ---------- !help (trong kênh đăng ký ca) / !helpca (mọi kênh) ----------
  async help(ctx, anyRoom = false) {
    if (!anyRoom && !this.inRoom(ctx)) return;
    const caList = Array.from({ length: NUM_CA }, (_, i) => `\`${p2(i + 1)}\` ${caLabel(i + 1)}`);
    const half = NUM_CA / 2;
    const embed = new EmbedBuilder()
      .setTitle('📖 Hướng dẫn đăng ký ca trực')
      .setColor(COLORS.blue)
      .setDescription(
        `Mỗi ngày có **${NUM_CA} ca**, mỗi ca **${CA_HOURS} tiếng** (giờ VN). ` +
          `Mỗi PD đăng ký tối đa **${MAX_CA_PER_DAY} ca/ngày**, mỗi ca tối đa **${MAX_PER_CA} người**. ` +
          `Đăng ký được từ hôm nay đến ${DAYS_AHEAD} ngày tới.` +
          (ROOMS.DANG_KY_CA ? `\nCác lệnh chỉ dùng trong <#${ROOMS.DANG_KY_CA}>.` : ''),
      )
      .addFields(
        {
          name: '📝 Lệnh cho PD',
          value: [
            '`!dangky <ca> [ca 2] [ngày]` — đăng ký ca',
            '  ↳ `!dangky 8` · `!dangky 14-16 20-22` · `!dangky 3 mai` · `!dangky 5 18/11`',
            '`!huyca <ca> [ngày]` — hủy ca (trước giờ ca bắt đầu)',
            '  ↳ `!huyca 8` · `!huyca 14-16 mai`',
            '`!lichtruc [ngày]` — xem ca trống / đã đủ người trong ngày',
            '  ↳ `!lichtruc` · `!lichtruc mai` · `!lichtruc 18/11`',
            '`!cacuatoi` — xem ca mình đã đăng ký 7 ngày tới',
          ].join('\n'),
        },
        {
          name: `🛡️ Lệnh quản lý (role ${BOT_ADMIN_ROLE})`,
          value: '`!xoaca <callsign|momo> <ca> [ngày]` — xóa ca của PD khác\n  ↳ `!xoaca 609 8 mai`',
        },
        { name: '🕒 Danh sách ca', value: caList.slice(0, half).join('\n'), inline: true },
        { name: '​', value: caList.slice(half).join('\n'), inline: true },
        {
          name: '📌 Ghi chú',
          value: [
            '• Ca nhập bằng **số ca** (`1`–`12`) hoặc **khung giờ chẵn** (`14-16`).',
            '• Ngày: bỏ trống = hôm nay, `mai`, `dd/mm` hoặc `dd/mm/yyyy`.',
            `• Ca bắt đầu ${REMIND_AFTER_MIN} phút mà chưa onduty sẽ bị bot nhắc và ghi vào sheet.`,
            '• Lịch tổng xem trong Google Sheet, tab **Lich-Truc**.',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Gõ !help trong kênh đăng ký ca hoặc !helpca ở bất kỳ kênh nào' });
    return ctx.reply({ embeds: [embed] });
  }

  // ---------- !cacuatoi ----------
  async caCuaToi(ctx) {
    if (!this.inRoom(ctx)) return;
    const me = await this.findOfficer(ctx.author);
    if (!me) return ctx.reply('❌ Bạn không có trong danh sách PD (tab Online).');
    const ws = await this.dataSheet();
    const today = startOfDay(nowVN());
    const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addMs(today, i * DAY_MS));
    const mine = (await this.activeRows(ws)).filter((r) => r.momo === me.momo);
    const lines = days
      .map((d) => {
        const cas = mine.filter((r) => r.day === dayKey(d)).sort((a, b) => a.ca - b.ca);
        return cas.length ? `• **${dayShort(d)}**: ${cas.map((r) => `Ca ${r.ca} \`${caLabel(r.ca)}\``).join(', ')}` : null;
      })
      .filter(Boolean);
    return ctx.reply(lines.length ? `ℹ️ Ca trực của **${me.cs} | ${me.name}** (7 ngày tới):\n${lines.join('\n')}` : '📭 Bạn chưa đăng ký ca nào trong 7 ngày tới.');
  }

  // ---------- Vẽ tab Lich-Truc: 12 ca x 7 ngày, mỗi ca 2 dòng (2 chỗ) ----------
  async renderView() {
    const ws = await this.dataSheet();
    const active = await this.activeRows(ws);
    const [view, created] = await this.bot.gs.ensureWorksheet(SHEET_IDS.MAIN, VIEW_TAB, { rows: 3 + NUM_CA * MAX_PER_CA + 5, cols: 9, frozenRows: 2 });
    if (created) await view.batch(viewFormatRequests(view.sheetId));

    const today = startOfDay(nowVN());
    const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addMs(today, i * DAY_MS));
    const grid = [
      [`LỊCH CA TRỰC GCPD (cập nhật ${fmt(nowVN(), 'HH:mm DD/MM/YYYY')}) — đăng ký bằng !dangky trên Discord`, '', '', '', '', '', '', '', ''],
      ['Ca', 'Khung giờ', ...days.map(dayShort)],
    ];
    for (let ca = 1; ca <= NUM_CA; ca++) {
      for (let slot = 0; slot < MAX_PER_CA; slot++) {
        const row = [slot === 0 ? `Ca ${ca}` : '', slot === 0 ? caLabel(ca) : ''];
        for (const d of days) {
          const r = active.filter((x) => x.day === dayKey(d) && x.ca === ca)[slot];
          row.push(r ? `${r.cs} | ${r.name}` : '');
        }
        grid.push(row);
      }
    }
    await view.updateRange('A1', grid, 'RAW');
  }
}

// ---------- Định dạng ----------
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

function boldRow(sheetId, rowIdx, nCols, bg) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: nCols },
      cell: { userEnteredFormat: { backgroundColor: rgb(bg), textFormat: { bold: true, foregroundColor: rgb('#FFFFFF') }, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  };
}

function viewFormatRequests(sheetId) {
  const nCols = 9;
  const lastRow = 2 + NUM_CA * MAX_PER_CA;
  const reqs = [
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: nCols }, mergeType: 'MERGE_ALL' } },
    boldRow(sheetId, 0, nCols, '#0B2545'),
    boldRow(sheetId, 1, nCols, '#1F3864'),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, verticalAlignment: 'MIDDLE', horizontalAlignment: 'CENTER', backgroundColor: rgb('#D9E2F3') } },
        fields: 'userEnteredFormat(textFormat,verticalAlignment,horizontalAlignment,backgroundColor)',
      },
    },
    {
      updateBorders: {
        range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: nCols },
        top: { style: 'SOLID' }, bottom: { style: 'SOLID' }, left: { style: 'SOLID' }, right: { style: 'SOLID' },
        innerHorizontal: { style: 'DOTTED' }, innerVertical: { style: 'SOLID' },
      },
    },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 60 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: nCols }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
    // Ô trống của ca = nền xanh nhạt (còn chỗ), có người = trắng
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 2, endColumnIndex: nCols }],
          booleanRule: { condition: { type: 'BLANK' }, format: { backgroundColor: rgb('#E2F0D9') } },
        },
      },
    },
  ];
  for (let ca = 0; ca < NUM_CA; ca++) {
    const r0 = 2 + ca * MAX_PER_CA;
    for (const c of [0, 1]) {
      reqs.push({ mergeCells: { range: { sheetId, startRowIndex: r0, endRowIndex: r0 + MAX_PER_CA, startColumnIndex: c, endColumnIndex: c + 1 }, mergeType: 'MERGE_ALL' } });
    }
    // Viền đậm giữa các ca
    reqs.push({
      updateBorders: {
        range: { sheetId, startRowIndex: r0, endRowIndex: r0 + MAX_PER_CA, startColumnIndex: 0, endColumnIndex: nCols },
        bottom: { style: 'SOLID_MEDIUM' },
      },
    });
  }
  return reqs;
}
