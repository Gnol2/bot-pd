import { EmbedBuilder } from 'discord.js';
import { ROOMS } from './config.js';
import { fmt, nowVN, roleMention } from './utils.js';

// ==========================================
// CẢNH BÁO VI PHẠM DÙNG CHUNG
// Mọi loại gửi vào 1 kênh (ROOMS.VI_PHAM), embed gọn: tiêu đề + các dòng "**Nhãn:** giá trị"
// + footer "<Hệ thống> • YYYY-MM-DD HH:mm:ss". Mỗi loại 1 màu để nhìn là phân biệt.
// ==========================================
export const VIOLATION_TYPES = {
  MOMO_LA: { title: 'Momo lạ OnDuty', color: 0xe67e22, system: 'Duty System' }, // cam
  CONG_NGOAI: { title: 'Người ngoài dùng còng tay', color: 0x9b59b6, system: 'Handcuff System' }, // tím
  CONG_OFFDUTY: { title: 'Còng tay khi OFF DUTY', color: 0xf1c40f, system: 'Handcuff System' }, // vàng
  SUA_MDT: { title: 'Sửa MDT trái phép', color: 0xe74c3c, system: 'MDT System' }, // đỏ
};

/**
 * @param bot     client
 * @param type    khoá trong VIOLATION_TYPES
 * @param lines   { 'Nhãn': 'giá trị' } theo thứ tự hiển thị, giá trị rỗng thì bỏ dòng
 * @param opts.time      thời điểm vi phạm: Date giờ VN (toVN/nowVN) hoặc chuỗi đã định dạng
 * @param opts.pingSo    tag Sở Trưởng + Sở Phó
 * @param opts.pings     tag thêm (vd "<@id>")
 */
export async function sendViolation(bot, type, lines, { time, pingSo = false, pings = [] } = {}) {
  const t = VIOLATION_TYPES[type];
  const ch = bot.channels.cache.get(ROOMS.VI_PHAM);
  if (!t || !ch) return console.error(`[ViPham] LỖI: không gửi được cảnh báo ${type} (kênh VI_PHAM ${ROOMS.VI_PHAM})`);

  const desc = Object.entries(lines)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n');
  const when = typeof time === 'string' && time ? time : fmt(time ?? nowVN(), 'YYYY-MM-DD HH:mm:ss');
  const embed = new EmbedBuilder()
    .setTitle(t.title)
    .setColor(t.color)
    .setDescription(desc.slice(0, 4096) || '—')
    .setFooter({ text: `${t.system} • ${when}` });

  const tags = [...(pingSo ? [roleMention(ch.guild, 'Sở Trưởng Cảnh Sát'), roleMention(ch.guild, 'Sở Phó Cảnh Sát')] : []), ...pings];
  await ch
    .send({ content: tags.join(' ') || undefined, embeds: [embed], allowedMentions: { parse: ['roles', 'users'] } })
    .catch((e) => console.error(`[ViPham] LỖI gửi cảnh báo ${type}:`, e.message));
}
