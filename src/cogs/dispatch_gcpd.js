import { Cog } from '../core/Cog.js';
import { ROOMS, FIREBASE_URL } from '../config.js';
import { fmt, toVN, nowVN } from '../utils.js';

// Đẩy dispatch mới nhất lên Firebase Realtime Database
export default class DispatchGCPD extends Cog {
  async onMessage(message) {
    if (message.channel.id !== ROOMS.DISPATCH || !message.embeds.length) return;

    for (const embed of message.embeds) {
      const title = embed.title ?? '';
      const description = embed.description ?? '';

      let creatorText = 'Không rõ';
      for (const f of embed.fields ?? []) {
        if (f.name.includes('Người tạo') || f.name.includes('ID') || f.value.includes('ID')) {
          creatorText = `${f.name}: ${f.value}`;
        }
      }

      const full = `${title} ${description} ${creatorText}`.toUpperCase();
      let code = '10-90';
      if (full.includes('10-36A') || full.includes('TẤN CÔNG PD')) code = '10-36A';
      else if (full.includes('10-35') || full.includes('TRỘM XE')) code = '10-35';
      else if (full.includes('10-70') || full.includes('BIỂN BÁO')) code = '10-70';
      else if (
        ['10-90', 'HÀNG TRẮNG', 'LINH KIỆN', 'QUẶNG LẬU', 'CƯỚP CỬA HÀNG'].some((k) => full.includes(k))
      )
        code = '10-90';

      const timestamp = embed.timestamp
        ? fmt(toVN(new Date(embed.timestamp)), 'HH:mm:ss DD/MM/YYYY')
        : fmt(nowVN(), 'HH:mm:ss DD/MM/YYYY');

      const payload = { code, title: title || 'Thông báo Dispatch', creator: creatorText, timestamp };

      try {
        const res = await fetch(FIREBASE_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) console.log(`[Firebase] 🚀 Đã đẩy Dispatch: ${code} - ${timestamp}`);
        else console.error(`[Firebase] ❌ Lỗi đẩy dữ liệu, HTTP code: ${res.status}`);
      } catch (e) {
        console.error(`[Firebase] ❌ Lỗi kết nối: ${e.message}`);
      }
    }
  }
}
