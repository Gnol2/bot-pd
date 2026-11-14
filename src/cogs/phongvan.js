import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { COLORS, roleByName } from '../utils.js';

// Mỗi 60 giây: có dòng mới trong sheet form tuyển dụng -> đăng hồ sơ lên Discord và ping các sếp
export default class PhongVan extends Cog {
  constructor(bot) {
    super(bot);
    this.lastRowCount = null;
    this.loop('check_new_applications', 60_000, () => this.check());
  }

  async check() {
    try {
      const sheet = this.bot.sheets.phongvan;
      if (!sheet) return;

      const allRows = await sheet.getAllValues();
      if (!allRows.length || allRows.length < 2) return;
      const current = allRows.length;

      // Lần chạy đầu (bot vừa khởi động): chỉ ghi nhớ số dòng
      if (this.lastRowCount === null) {
        this.lastRowCount = current;
        return;
      }

      if (current > this.lastRowCount) {
        const channel = this.bot.channels.cache.get(ROOMS.PHONGVAN);
        if (!channel) return console.error('❌ [PhongVan] Không tìm thấy kênh gửi hồ sơ ứng tuyển!');

        const headers = allRows[0];
        const mentions = ['FTO', 'Sở Trưởng Cảnh Sát', 'Sở Phó Cảnh Sát']
          .map((n) => roleByName(channel.guild, n))
          .filter(Boolean)
          .map((r) => r.toString());
        const ping = mentions.length
          ? `${mentions.join(' ')} 🚨 **CÓ ĐƠN ỨNG TUYỂN MỚI NÈ CÁC SẾP ƠI!**`
          : '🚨 **CÓ ĐƠN ỨNG TUYỂN MỚI!**';

        for (let i = this.lastRowCount; i < current; i++) {
          const row = allRows[i];
          const embed = new EmbedBuilder()
            .setTitle('📝 HỒ SƠ ỨNG TUYỂN GCPD')
            .setDescription('Vừa có một công dân nộp đơn đăng ký gia nhập Sở Cảnh Sát GCPD! Chi tiết hồ sơ bên dưới:')
            .setColor(COLORS.green)
            .setThumbnail('https://i.imgur.com/8Qe5u9e.png')
            .setFooter({ text: 'Hệ thống Tuyển dụng GCPD' });

          let fieldCount = 0;
          for (let c = 0; c < headers.length; c++) {
            const question = String(headers[c]).trim();
            let answer = c < row.length ? String(row[c]).trim() : 'Không có';
            if (!question || !answer) continue;
            if (fieldCount >= 25) break; // Giới hạn Discord: 25 field / embed
            if (answer.length > 1000) answer = answer.slice(0, 1000) + '...\n*(Câu trả lời quá dài)*';
            embed.addFields({ name: `🔹 ${question}`.slice(0, 256), value: '```\n' + answer + '\n```', inline: false });
            fieldCount++;
          }

          await channel.send({ content: ping, embeds: [embed], allowedMentions: { parse: ['roles'] } });
          await this.sleep(1000);
        }
        this.lastRowCount = current;
      }
    } catch (e) {
      console.error('❌ [PhongVan] Lỗi Radar quét form ứng tuyển:', e.message);
    }
  }
}
