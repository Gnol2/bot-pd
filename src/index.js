import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { SheetsClient } from './sheets.js';
import { SHEET_IDS, ROOMS, COGS, BOT_ADMIN_ROLE } from './config.js';
import { buildSlashDefs, ARG_OPTION, SLASH_META, COG_LABELS } from './slash.js';
import { hasRole, isBotAdmin, NO_PERM, fmt, nowVN, Mutex } from './utils.js';

// Mọi dòng log có mốc giờ VN: "17/11 21:05:09 [Module] ..."
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(fmt(nowVN(), 'DD/MM HH:mm:ss'), ...a);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================
// CẤU HÌNH GOOGLE SHEETS
// ==========================================
const credsStr = process.env.GOOGLE_CREDENTIALS;
if (!credsStr) {
  console.error('[Bot] LỖI: thiếu GOOGLE_CREDENTIALS trong .env');
  process.exit(1);
}
const gs = new SheetsClient(JSON.parse(credsStr));

// ==========================================
// KHỞI TẠO BOT
// ==========================================
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

bot.gs = gs;
bot.rooms = ROOMS;
// Khoá chung cho mọi module ghi sheet Giay-To theo số hàng (log_giayto xoá hàng -> các hàng dồn lên)
bot.giayToLock = new Mutex();
let resolveReady;
bot.readyPromise = new Promise((r) => (resolveReady = r));

async function openSheets() {
  const M = SHEET_IDS.MAIN;
  const H = SHEET_IDS.HOME;
  bot.sheets = {
    data: await gs.worksheet(M, 'Hoa-Don-113'),
    team: await gs.worksheet(M, 'DS-113'),
    hoadon: await gs.worksheet(M, 'Hoa-Don'),
    incident: await gs.worksheet(M, 'Incident'),
    tamGiam: await gs.worksheet(M, 'Tam-Giam'),
    giayTo: await gs.worksheet(M, 'Giay-To'),
    online: await gs.worksheet(M, 'Online'),
    // FIX: bản Python gán sheet_cccdgplx 2 lần, lần sau đè thành "Danh-Sach-PD" (lỗi).
    cccdgplx: await gs.worksheet(M, 'CCCDGPLX'),
    phongvan: await gs.worksheet(SHEET_IDS.PHONGVAN, 'tuyenpd'),
    dispatch: await gs.worksheet(H, 'Dispatch'),
    role: await gs.worksheet(H, 'GCPD HOME'),
  };
}

// ==========================================
// QUẢN LÝ MODULE (COG)
// ==========================================
const cogs = new Map();

async function loadCog(name) {
  if (!/^\w+$/.test(name)) throw new Error('Tên module không hợp lệ.');
  if (cogs.has(name)) throw new Error(`Module ${name} đã được load rồi`);
  const file = path.join(__dirname, 'cogs', `${name}.js`);
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  const cog = new mod.default(bot);
  cogs.set(name, cog);
  registerSlashCommands();
}

function unloadCog(name) {
  const cog = cogs.get(name);
  if (!cog) throw new Error(`Module ${name} chưa được load`);
  cog.unload();
  cogs.delete(name);
  registerSlashCommands();
}

// ==========================================
// BỘ LỆNH QUẢN TRỊ MODULE (Dành cho role PD bot admin)
// ==========================================
const adminCommands = {
  async load(ctx, name) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    try {
      await loadCog(name);
      await ctx.send(`✅ Đã load \`cogs.${name}\`.`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  },
  async unload(ctx, name) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    try {
      unloadCog(name);
      await ctx.send(`✅ Đã unload \`cogs.${name}\`.`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  },
  async reload(ctx, name) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    try {
      unloadCog(name);
      await loadCog(name);
      await ctx.send(`✅ Đã reload \`cogs.${name}\`.`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  },
};

// /help: liệt kê lệnh của các module đang bật, gom theo nhóm (tự cập nhật khi load/unload module)
adminCommands.help = async (ctx) => {
  const line = (n) => {
    const m = SLASH_META[n];
    // Chỉ lấy phần cú pháp, bỏ ví dụ/ghi chú (vẫn hiện đầy đủ trong ô tham_so khi gõ lệnh)
    const hint = m?.args ? ` ${m.args.split(' — ')[0].replace(/\s*\(.*\)$/, '')}` : '';
    return `\`/${n}${hint}\` — ${m?.desc ?? ''}`.replace(/ — $/, '');
  };
  const groups = new Map();
  for (const [file, cog] of cogs) {
    const names = Object.keys(cog.commands);
    if (!names.length) continue;
    const label = COG_LABELS[file] ?? `📦 ${file}`;
    groups.set(label, [...(groups.get(label) ?? []), ...names]);
  }
  groups.set(`🛡️ Quản trị module (role ${BOT_ADMIN_ROLE})`, ['load', 'unload', 'reload']);

  const fields = [];
  for (const [label, names] of groups) {
    // Field tối đa 1024 ký tự -> nhóm dài thì tách làm nhiều field
    const chunks = [''];
    for (const l of names.filter((n) => n !== 'help').map(line)) {
      if (chunks.at(-1).length + l.length + 1 > 1024) chunks.push('');
      chunks[chunks.length - 1] += `${chunks.at(-1) ? '\n' : ''}${l}`;
    }
    chunks.filter(Boolean).forEach((value, i) => fields.push({ name: i === 0 ? label : '​', value }));
  }

  const embed = new EmbedBuilder()
    .setTitle('📖 Danh sách lệnh bot GCPD')
    .setColor(0x3498db)
    .setDescription(
      'Gõ `/` rồi chọn lệnh, phần sau tên lệnh nhập vào ô **tham_so**.\n' +
        '`<...>` = bắt buộc · `[...]` = tuỳ chọn. Một số lệnh chỉ dùng được ở kênh riêng hoặc cần quyền quản lý.\n' +
        'Hướng dẫn chi tiết: `/helpca` (đăng ký ca) · `/helpchamcong` (chấm công).',
    )
    .addFields(fields.slice(0, 25));
  return ctx.reply({ embeds: [embed] });
};

function findCommand(name) {
  if (adminCommands[name]) return adminCommands[name];
  for (const cog of cogs.values()) if (cog.commands[name]) return cog.commands[name];
  return null;
}

// ==========================================
// ĐĂNG KÝ SLASH COMMAND (/lệnh)
// ==========================================
// Đăng ký theo từng server (có hiệu lực ngay, không phải chờ như lệnh global).
// Gọi lại sau mỗi lần load/unload/reload module để danh sách lệnh luôn khớp.
let registerTimer = null;
function registerSlashCommands() {
  if (!bot.isReady()) return;
  clearTimeout(registerTimer);
  registerTimer = setTimeout(async () => {
    const names = [...Object.keys(adminCommands)];
    for (const cog of cogs.values()) names.push(...Object.keys(cog.commands));
    const defs = buildSlashDefs(names);
    for (const guild of bot.guilds.cache.values()) {
      try {
        await guild.commands.set(defs);
      } catch (e) {
        console.error(`[Bot] LỖI đăng ký slash command ở server ${guild.name}:`, e.message);
      }
    }
    console.log(`[Bot] Đã đăng ký ${defs.length} slash command`);
  }, 2000);
}

const MENTION_RE = /<@[!&]?\d+>|@everyone|@here/;

// Tạo ctx giống lệnh prefix cũ để các module không phải sửa.
// Phản hồi đầu tiên thay cho "Bot đang suy nghĩ...", các phản hồi sau là followUp.
function makeInteractionCtx(interaction, name, argStr) {
  const args = argStr ? argStr.split(/\s+/) : [];
  let first = true;
  const echo = argStr ? `\`/${name} ${argStr}\`` : '';

  const respond = async (content) => {
    const payload = typeof content === 'string' ? { content } : { ...content };
    try {
      if (first) {
        first = false;
        // Hiện lại lệnh + tham số đã gõ (người khác thấy được, checker_blht dựa vào dòng này để tìm dấu /vipham)
        if (echo) payload.content = payload.content ? `${echo}\n${payload.content}` : echo;
        // Sửa tin nhắn thì Discord không ping -> có mention thì gửi tin mới
        if (MENTION_RE.test(payload.content ?? '')) {
          const msg = await interaction.followUp(payload);
          await interaction.deleteReply().catch(() => {});
          return msg;
        }
        return await interaction.editReply(payload);
      }
      return await interaction.followUp(payload);
    } catch (e) {
      // Token interaction hết hạn (lệnh chạy > 15 phút) -> gửi thẳng vào kênh
      console.warn(`[Lệnh] /${name}: phản hồi interaction lỗi (${e.message}), gửi vào kênh`);
      return interaction.channel.send(payload);
    }
  };

  const ctx = {
    bot,
    interaction,
    // Giả lập message cũ: vài module đọc content (tự tách tham số) và createdAt
    message: { content: `/${name}${argStr ? ` ${argStr}` : ''}`, createdAt: interaction.createdAt },
    guild: interaction.guild,
    channel: interaction.channel,
    author: interaction.member,
    args,
    send: respond,
    reply: respond,
    get responded() {
      return !first;
    },
  };
  return ctx;
}

// ==========================================
// SỰ KIỆN DISCORD
// ==========================================
bot.once(Events.ClientReady, async (c) => {
  // Nạp toàn bộ thành viên để tra cứu theo callsign (display name)
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.members.fetch();
    } catch (e) {
      console.error(`[Bot] LỖI tải thành viên server ${guild.name}:`, e.message);
    }
  }
  console.log(`[Bot] Online: ${c.user.tag} (${c.guilds.cache.size} server, ${cogs.size} module)`);
  resolveReady();
  registerSlashCommands();
});

// Bot được mời vào server mới -> đăng ký lệnh cho server đó
bot.on(Events.GuildCreate, () => registerSlashCommands());

bot.on(Events.MessageCreate, async (message) => {
  // Listener của các module chạy song song (giống @commands.Cog.listener)
  for (const [name, cog] of cogs) {
    if (typeof cog.onMessage === 'function') {
      cog.onMessage(message).catch((e) => console.error(`[${name}] LỖI xử lý tin nhắn:`, e));
    }
  }
});

// Xử lý slash command "/"
bot.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const name = interaction.commandName;
  const handler = findCommand(name);
  if (!handler) {
    return interaction
      .reply({ content: `⚠️ Lệnh \`/${name}\` đang tắt (module chưa load).`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }

  // Phải phản hồi trong 3 giây -> báo "đang xử lý" trước, lệnh đọc Sheets xong mới trả kết quả
  try {
    await interaction.deferReply();
  } catch (e) {
    return console.error(`[Lệnh] LỖI defer /${name}:`, e.message);
  }
  const argStr = (interaction.options.getString(ARG_OPTION) ?? '').trim();
  const ctx = makeInteractionCtx(interaction, name, argStr);
  try {
    await handler(ctx, ...ctx.args);
  } catch (e) {
    console.error(`[Lệnh] LỖI /${name}:`, e);
    if (!ctx.responded) await ctx.reply(`❌ Lỗi: ${e.message}`).catch(() => {});
  }

  // Lệnh không trả lời gì (sai kênh, không có quyền...) -> xoá "đang xử lý" và báo riêng người gõ
  if (!ctx.responded) {
    await interaction.deleteReply().catch(() => {});
    await interaction
      .followUp({ content: `ℹ️ \`/${name}\` không có kết quả — có thể lệnh này không dùng ở kênh này.`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('[Bot] LỖI chưa bắt (unhandledRejection):', e));

async function main() {
  await openSheets();
  for (const name of COGS) {
    try {
      await loadCog(name);
      console.log(`[Module] Bật ${name}`);
    } catch (e) {
      console.error(`[Module] LỖI bật ${name}:`, e);
    }
  }
  await bot.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error('[Bot] LỖI khởi động:', e);
  process.exit(1);
});
