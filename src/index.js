import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { SheetsClient } from './sheets.js';
import { PREFIX, SHEET_IDS, ROOMS, COGS } from './config.js';
import { hasRole, isBotAdmin, NO_PERM, fmt, nowVN } from './utils.js';

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
}

function unloadCog(name) {
  const cog = cogs.get(name);
  if (!cog) throw new Error(`Module ${name} chưa được load`);
  cog.unload();
  cogs.delete(name);
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

function findCommand(name) {
  if (adminCommands[name]) return adminCommands[name];
  for (const cog of cogs.values()) if (cog.commands[name]) return cog.commands[name];
  return null;
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
});

bot.on(Events.MessageCreate, async (message) => {
  // Listener của các module chạy song song (giống @commands.Cog.listener)
  for (const [name, cog] of cogs) {
    if (typeof cog.onMessage === 'function') {
      cog.onMessage(message).catch((e) => console.error(`[${name}] LỖI xử lý tin nhắn:`, e));
    }
  }

  // Xử lý lệnh prefix "!"
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;
  const [name, ...args] = message.content.slice(PREFIX.length).split(/\s+/);
  if (!name) return;
  const handler = findCommand(name);
  if (!handler) return;

  const ctx = {
    bot,
    message,
    guild: message.guild,
    channel: message.channel,
    author: message.member,
    args,
    send: (content) => message.channel.send(content),
    reply: (content) => message.reply(content),
  };
  try {
    await handler(ctx, ...args);
  } catch (e) {
    console.error(`[Lệnh] LỖI !${name}:`, e);
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
