import { SnowflakeUtil } from 'discord.js';
import { BOT_ADMIN_ROLE } from './config.js';

// ==========================================
// CHUỖI / SỐ
// ==========================================
export const S = (v) => (v === null || v === undefined ? '' : String(v)).trim(); // str(x).strip()
export const at = (row, i) => (row && i < row.length ? row[i] : ''); // row[i] an toàn
export const isDigits = (v) => /^\d+$/.test(String(v)); // str.isdigit()
export const toInt = (v, def = 0) => (isDigits(v) ? parseInt(String(v), 10) : def);
export const cleanMoney = (v) => String(v).replace(/[.,$]/g, '').trim();
export const money = (n) => Number(n).toLocaleString('en-US'); // f"{n:,}"
export const fmtG = (n) => String(parseFloat(Number(n).toPrecision(6))); // f"{n:g}"
export const cell = (row, col, value) => ({ row, col, value });
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const uniq = (arr) => [...new Set(arr)];

export function cleanRadio(raw) {
  const r = S(raw);
  if (!r) return '';
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(r)) return String(Number(r));
  return r;
}

// ==========================================
// THỜI GIAN
// Quy ước: "giờ VN" là Date đã cộng 7 tiếng, đọc bằng các hàm getUTC*()
// (giống datetime naive cộng timedelta(hours=7) trong bản Python)
// ==========================================
export const HOUR_MS = 3600_000;
export const DAY_MS = 86400_000;
export const VN_OFFSET_MS = 7 * HOUR_MS;

export const nowVN = () => new Date(Date.now() + VN_OFFSET_MS);
export const toVN = (d) => new Date(new Date(d).getTime() + VN_OFFSET_MS);
export const vnToUtc = (d) => new Date(d.getTime() - VN_OFFSET_MS);
export const addMs = (d, ms) => new Date(d.getTime() + ms);
export const weekday = (d) => (d.getUTCDay() + 6) % 7; // Thứ Hai = 0 như Python
export const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const endOfDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));

const p2 = (n) => String(n).padStart(2, '0');

// Token: YYYY MM DD HH mm ss
export function fmt(d, pattern) {
  const map = {
    YYYY: d.getUTCFullYear(),
    MM: p2(d.getUTCMonth() + 1),
    DD: p2(d.getUTCDate()),
    HH: p2(d.getUTCHours()),
    mm: p2(d.getUTCMinutes()),
    ss: p2(d.getUTCSeconds()),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t]);
}

function mk(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== mo - 1 ||
    t.getUTCDate() !== d ||
    t.getUTCHours() !== h ||
    t.getUTCMinutes() !== mi ||
    t.getUTCSeconds() !== s
  )
    return null;
  return t;
}

// "%Y-%m-%d %H:%M:%S"
export function parseYMDHMS(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(S(str));
  return m ? mk(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]) : null;
}

// "%d/%m/%Y %H:%M:%S"
export function parseDMYHMS(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(S(str));
  return m ? mk(+m[3], +m[2], +m[1], +m[4], +m[5], +m[6]) : null;
}

// "%d/%m/%Y"
export function parseDMY(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(S(str));
  return m ? mk(+m[3], +m[2], +m[1]) : null;
}

// "%Y-%m-%d"
export function parseYMD(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(S(str));
  return m ? mk(+m[1], +m[2], +m[3]) : null;
}

// Tên sheet tuần kiểu "2/11-8/11"
export function weekSheetName(start) {
  const end = addMs(start, 6 * DAY_MS);
  return `${start.getUTCDate()}/${start.getUTCMonth() + 1}-${end.getUTCDate()}/${end.getUTCMonth() + 1}`;
}

export function currentWeekStartVN() {
  const t = nowVN();
  return startOfDay(addMs(t, -weekday(t) * DAY_MS));
}

// ==========================================
// DISCORD
// ==========================================
export const COLORS = {
  gold: 0xf1c40f,
  blue: 0x3498db,
  red: 0xe74c3c,
  green: 0x2ecc71,
  blurple: 0x5865f2,
};

export const hasRole = (member, name) => !!member?.roles?.cache?.some((r) => r.name === name);
export const roleByName = (guild, name) => guild?.roles.cache.find((r) => r.name === name) ?? null;
export const roleMention = (guild, name) => roleByName(guild, name)?.toString() ?? `@${name}`;
export const callsignOf = (displayName) => String(displayName ?? '').split('|')[0].trim();

// Quyền quản lý bot: chỉ role BOT_ADMIN_ROLE ("PD bot admin")
export const isBotAdmin = (member) => hasRole(member, BOT_ADMIN_ROLE);
export const NO_PERM = `❌ Cần role **${BOT_ADMIN_ROLE}**.`;

// Tương đương utils.lay_member_theo_callsign / lay_id_theo_callsign:
// lấy thành viên đầu tiên có display name BẮT ĐẦU bằng callsign.
// (Thêm chặn callsign rỗng: bản Python với callsign "" sẽ khớp bừa thành viên đầu tiên)
export function layMemberTheoCallsign(guild, callsign) {
  if (!guild || callsign === null || callsign === undefined) return null;
  const cs = String(callsign);
  if (!cs) return null;
  return guild.members.cache.find((m) => m.displayName.startsWith(cs)) ?? null;
}
export const layIdTheoCallsign = (guild, callsign) => layMemberTheoCallsign(guild, callsign)?.id ?? null;

export function csToMemberMap(guild) {
  const map = new Map();
  if (!guild) return map;
  for (const m of guild.members.cache.values()) map.set(callsignOf(m.displayName), m);
  return map;
}

export async function sendTemp(channel, content, ms) {
  const m = await channel.send(content);
  setTimeout(() => m.delete().catch(() => {}), ms);
  return m;
}

// Tương đương channel.history(limit, after, before, oldest_first) của discord.py.
// limit = null -> không giới hạn. oldestFirst mặc định = true nếu có `after` (giống discord.py).
export async function* history(channel, { limit = 100, after = null, before = null, oldestFirst } = {}) {
  let remaining = limit ?? Infinity;
  const asc = oldestFirst ?? !!after;
  const afterMs = after ? new Date(after).getTime() : null;
  const beforeMs = before ? new Date(before).getTime() : null;

  if (asc) {
    let cursor = afterMs !== null ? SnowflakeUtil.generate({ timestamp: afterMs }).toString() : '0';
    while (remaining > 0) {
      const want = Math.min(100, remaining);
      const batch = await channel.messages.fetch({ limit: want, after: cursor, cache: false });
      if (!batch.size) return;
      const msgs = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of msgs) {
        if (beforeMs !== null && m.createdTimestamp >= beforeMs) return;
        yield m;
        if (--remaining <= 0) return;
      }
      cursor = msgs[msgs.length - 1].id;
      if (batch.size < want) return;
    }
  } else {
    let cursor = beforeMs !== null ? SnowflakeUtil.generate({ timestamp: beforeMs }).toString() : null;
    while (remaining > 0) {
      const want = Math.min(100, remaining);
      const opts = { limit: want, cache: false };
      if (cursor) opts.before = cursor;
      const batch = await channel.messages.fetch(opts);
      if (!batch.size) return;
      const msgs = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const m of msgs) {
        if (afterMs !== null && m.createdTimestamp <= afterMs) return;
        yield m;
        if (--remaining <= 0) return;
      }
      cursor = msgs[msgs.length - 1].id;
      if (batch.size < want) return;
    }
  }
}

// Khoá tuần tự (tương đương asyncio.Lock)
export class Mutex {
  constructor() {
    this._p = Promise.resolve();
  }
  async run(fn) {
    const prev = this._p;
    let release;
    this._p = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ==========================================
// SHEET HELPERS (chuyển từ utils.py)
// ==========================================
// Chuỗi toàn chữ số -> đổi sang số nguyên (để Sheet nhận là số), còn lại giữ nguyên
export function sanitizeVal(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t; // số quá lớn giữ dạng chuỗi để không mất chính xác
  }
  return v;
}
export const sanitizeRow = (row) => row.map(sanitizeVal);

// Bóc tách embed hóa đơn (PA Billing). Chỉ nhận "Chưa thanh toán".
// Trả về 9 cột: [thời gian, tiêu đề, id gửi, tên gửi, id nhận, tên nhận, số tiền, công việc, trạng thái]
export function parseBillEmbed(message) {
  const embed = message.embeds?.[0];
  if (!embed) return null;

  let full = `${embed.title ?? ''}\n${embed.description ?? ''}\n`;
  for (const f of embed.fields ?? []) full += `${f.name}\n${f.value}\n`;
  full = full.replace(/[*_`]/g, '');

  const tieuDe = /Tiêu đề\s*\n([^\n]+)/i.exec(full)?.[1].trim() ?? '';
  const mNg = /Người gửi\s*\n\[(\d+)\]\s*([^\n]+)/i.exec(full);
  const mNn = /Người nhận\s*\n\[(\d+)\]\s*([^\n]+)/i.exec(full);
  const soTien = /Số tiền\s*\n(\$?[\d,.]+)/i.exec(full)?.[1].replace('$', '').trim() ?? '';
  const congViec = /Công việc\s*\n([^\n]+)/i.exec(full)?.[1].trim() ?? '';
  const trangThai = (/Trạng thái\s*\n([^\n]+)/i.exec(full)?.[1] ?? '').replace(/🟡|🟢|🔴/gu, '').trim();

  if (!trangThai.toLowerCase().includes('chưa thanh toán')) return null;
  if (!mNg) return null;

  const ts = fmt(toVN(message.createdAt), 'YYYY-MM-DD HH:mm:ss');
  const row = [
    ts,
    tieuDe,
    mNg[1].trim(),
    mNg[2].trim(),
    mNn ? mNn[1].trim() : '',
    mNn ? mNn[2].trim() : '',
    soTien,
    congViec,
    trangThai,
  ];
  return row.map((v) => String(v).replace(/['=]/g, '').trim());
}

// Tương đương utils.process_embed_message: đọc theo tên field của mọi embed.
// Trả về 8 cột: ['thời gian, tiêu đề, id gửi, tên gửi, id nhận, tên nhận, số tiền, "Chưa thanh toán"]
export function processEmbedMessage(message, requireVpgtKthc = true) {
  if (!message.embeds?.length) return null;
  let tieuDe = '', nguoiGui = '', nguoiNhan = '', soTien = '', trangThai = '';
  for (const embed of message.embeds) {
    for (const f of embed.fields ?? []) {
      const n = String(f.name).toLowerCase();
      const v = String(f.value);
      if (n.includes('tiêu đề')) tieuDe = v;
      else if (n.includes('người gửi')) nguoiGui = v;
      else if (n.includes('người nhận')) nguoiNhan = v;
      else if (n.includes('số tiền')) soTien = v;
      else if (n.includes('trạng thái')) trangThai = v;
    }
  }
  if (!trangThai.includes('Chưa thanh toán')) return null;
  if (requireVpgtKthc) {
    const t = tieuDe.toUpperCase();
    if (!t.includes('VPGT') && !t.includes('KTHC')) return null;
  }

  const timeStr = "'" + fmt(toVN(message.createdAt), 'YYYY-MM-DD HH:mm:ss');
  const mGui = /\[(.*?)\]\s*(.*)/.exec(nguoiGui);
  const mNhan = /\[(.*?)\]\s*(.*)/.exec(nguoiNhan);
  const sSach = soTien.replace(/\$/g, '').replace(/,/g, '').trim();

  return [
    timeStr,
    tieuDe,
    mGui ? mGui[1].trim() : '',
    mGui ? mGui[2].trim() : nguoiGui,
    mNhan ? mNhan[1].trim() : '',
    mNhan ? mNhan[2].trim() : nguoiNhan,
    sSach,
    'Chưa thanh toán',
  ];
}
