import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { cell, hasRole, history, isBotAdmin, NO_PERM } from '../utils.js';

// Log Thay đổi chức vụ / Sa thải -> cập nhật sheet GCPD HOME (C = ID, D = Tên, H = Chức vụ)
export default class Role extends Cog {
  constructor(bot) {
    super(bot);
    this.queue = [];
    this.commands = { updaterole: (ctx, limit) => this.updateRole(ctx, limit) };
    this.loop('role_batch_processor', 10_000, () => this.batchProcessor());
  }

  parseRoleEmbed(message) {
    const embed = message.embeds?.[0];
    if (!embed) return null;

    let full = `${embed.title ?? ''}\n${embed.description ?? ''}\n`;
    for (const f of embed.fields ?? []) full += `${f.name}\n${f.value}\n`;
    full = full.replace(/[*`]/g, '');

    if (!full.includes('Thay đổi chức vụ')) return null;

    let targetName = '';
    let targetId = '';
    const m =
      /Nâng\/Hạ chức vụ cho:\s*(.*?)\s*\((.*?)\)/i.exec(full) ?? /Sa thải nhân viên:\s*(.*?)\s*\((.*?)\)/i.exec(full);
    if (m) {
      targetName = m[1].trim();
      const inside = m[2].trim(); // "ID: 1234" hoặc "Offline"
      if (inside.includes('ID:')) {
        const mNum = /ID:\s*(\d+)/i.exec(inside);
        if (mNum) targetId = mNum[1].trim();
      }
    }

    const newRole = /Chức vụ mới:\s*([^\n]+)/i.exec(full)?.[1].trim() ?? '';
    if (!targetName || !newRole) return null;
    return { target_id: targetId, target_name: targetName, new_role: newRole };
  }

  async batchProcessor() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 20);

    try {
      const sheet = this.bot.sheets.role;
      const allRows = await sheet.getAllValues();

      const idToRow = new Map();
      const nameToRow = new Map();
      const emptyRows = []; // Dòng có cột C trống

      allRows.forEach((row, idx) => {
        if (idx === 0) return;
        let hasId = false;
        if (row.length > 2) {
          const c = String(row[2]).trim();
          if (c) {
            idToRow.set(c, idx + 1);
            hasId = true;
          }
        }
        if (row.length > 3) {
          const d = String(row[3]).trim().toLowerCase();
          if (d) nameToRow.set(d, idx + 1);
        }
        if (!hasId) emptyRows.push(idx + 1);
      });

      const cells = [];
      const appends = [];

      const latest = new Map();
      for (const item of batch) {
        const key = item.target_id || item.target_name.toLowerCase();
        latest.set(key, { id: item.target_id, name: item.target_name, role: item.new_role });
      }

      for (const { id, name, role } of latest.values()) {
        let rowIdx = null;
        if (id && idToRow.has(id)) rowIdx = idToRow.get(id);
        else if (name && nameToRow.has(name.toLowerCase())) rowIdx = nameToRow.get(name.toLowerCase());

        if (rowIdx) {
          cells.push(cell(rowIdx, 8, role));
          if (id && !idToRow.has(id)) {
            cells.push(cell(rowIdx, 3, id));
            idToRow.set(id, rowIdx);
          }
          if (name && !nameToRow.has(name.toLowerCase())) {
            cells.push(cell(rowIdx, 4, name));
            nameToRow.set(name.toLowerCase(), rowIdx);
          }
        } else if (emptyRows.length) {
          rowIdx = emptyRows.shift();
          cells.push(cell(rowIdx, 3, id), cell(rowIdx, 4, name), cell(rowIdx, 8, role));
          if (id) idToRow.set(id, rowIdx);
          if (name) nameToRow.set(name.toLowerCase(), rowIdx);
        } else {
          appends.push(['', '', id, name, '', '', '', role]);
          const newIdx = allRows.length + appends.length;
          if (id) idToRow.set(id, newIdx);
          if (name) nameToRow.set(name.toLowerCase(), newIdx);
        }
      }

      if (cells.length) await sheet.updateCells(cells);
      if (appends.length) await sheet.appendRows(appends);
      console.log(`[ChucVu] Ghi sheet xong: sửa ${cells.length} ô, thêm ${appends.length} dòng`);
    } catch (e) {
      console.error('[ChucVu] LỖI ghi sheet:', e.message);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.ROLE || !message.embeds.length) return;
    try {
      const data = this.parseRoleEmbed(message);
      if (data) {
        this.queue.push(data);
        console.log(`[ChucVu] Nhận đổi chức vụ/sa thải: ${data.target_name} (${data.target_id || 'offline'})`);
      }
    } catch (e) {
      console.error('[ChucVu] LỖI đọc tin nhắn:', e.message);
    }
  }

  async updateRole(ctx, limitArg) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    const limit = limitArg && /^\d+$/.test(limitArg) ? parseInt(limitArg, 10) : 1000;

    await ctx.send(`⏳ Đang quét **${limit}** log đổi chức vụ/sa thải gần nhất...`);
    try {
      const channel = this.bot.channels.cache.get(ROOMS.ROLE);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh log Role.');

      const updates = new Map();
      for await (const message of history(channel, { limit })) {
        if (!message.embeds.length) continue;
        const data = this.parseRoleEmbed(message);
        if (data) {
          const key = data.target_id || data.target_name.toLowerCase();
          if (!updates.has(key)) updates.set(key, data); // Lấy bản mới nhất
        }
      }

      if (!updates.size) return ctx.send('📭 Không có log đổi chức vụ hợp lệ.');
      for (const pkg of updates.values()) this.queue.push(pkg);
      await ctx.send(`✅ Đã đưa **${updates.size}** thay đổi chức vụ vào hàng đợi.`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }
}
