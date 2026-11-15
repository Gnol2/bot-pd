import fs from 'node:fs';
import { Cog } from '../core/Cog.js';
import { ROOMS, alertRoom } from '../config.js';
import { S, cell, fmt, toVN, nowVN, vnToUtc, endOfDay, parseDMY, addMs, HOUR_MS, hasRole, roleMention, history, cleanRadio } from '../utils.js';

const MEMORY_FILE = 'nhansu_radio_memory.json';
const PID_RE = /(?:PLAYER\s*ID|ID)[\s:]*\n?(\d+)/; // chạy trên text đã viết hoa
const RADIO_PID_RE = /\b(?:PLAYER\s*ID|ID)[\s:]*\n?(\d+)/i;
const KENH_RE = /(?:sang kênh|New Channel|to channel|Kênh mới|Kênh|Channel|Tần số)[\s:]*\n?([\d.]+)/i;

// Chấm công Duty / Radio -> cột H, I của sheet Online; báo động momo lạ lên duty
export default class LogNhanSu extends Cog {
  constructor(bot) {
    super(bot);
    this.dutyQueue = [];
    this.radioQueue = [];
    this.lastRadioActions = this.loadMemory(); // { pid: { val, time: Date } }
    this.alertedUnknownPids = new Map(); // chống spam cảnh báo: khoá 4 tiếng

    this.commands = {
      updateduty: (ctx, a, b) => this.updateDuty(ctx, a, b),
      updateradio: (ctx, a, b) => this.updateRadio(ctx, a, b),
    };

    this.loop('nhansu_batch_processor', 10_000, () => this.batchProcessor());
    this.loop('periodic_nhansu_check', 5 * 60_000, () => this.periodicCheck());
  }

  // ==========================================
  // BỘ NHỚ Ổ CỨNG
  // ==========================================
  loadMemory() {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      for (const mem of Object.values(data)) if (mem.time) mem.time = new Date(mem.time);
      console.log('💾 [Nhân Sự] Đã nạp trí nhớ Đàm từ Ổ cứng thành công!');
      return data;
    } catch (e) {
      console.error('Lỗi đọc file trí nhớ Nhân Sự:', e.message);
      return {};
    }
  }

  saveMemory() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.lastRadioActions, null, 4), 'utf8');
    } catch {
      /* bỏ qua */
    }
  }

  extractFullText(embed, toUpper = false) {
    const parts = [String(embed.title ?? ''), String(embed.description ?? '')];
    if (embed.author?.name) parts.push(String(embed.author.name));
    for (const f of embed.fields ?? []) parts.push(`${f.name}\n${f.value}`);
    const res = parts.join('\n').replace(/[*`]/g, '');
    return toUpper ? res.toUpperCase() : res;
  }

  parseDutyEmbed(embed) {
    const etc = this.extractFullText(embed, true);
    const isOn = etc.includes('ON DUTY') || etc.includes('10-41');
    const isOff = etc.includes('OFF DUTY') || etc.includes('10-42');
    if (!isOn && !isOff) return null;
    const m = PID_RE.exec(etc);
    if (!m) return null;
    return { pid: m[1].trim(), status: isOn ? 'Đang Onduty' : ' ' };
  }

  parseRadioEmbed(embed) {
    const etc = this.extractFullText(embed, false);
    const isJoin = etc.includes('Tham Gia Kênh') || etc.includes('Join');
    const isLeave = etc.includes('Rời Kênh') || etc.includes('Leave');
    const isChange = etc.includes('Radio Channel Changed') || etc.includes('chuyển radio') || etc.includes('sang kênh');
    if (!isJoin && !isLeave && !isChange) return null;
    const m = RADIO_PID_RE.exec(etc);
    if (!m) return null;
    let val = ' ';
    if (isJoin || isChange) {
      const k = KENH_RE.exec(etc);
      val = k ? cleanRadio(k[1]) : ' ';
    }
    return { pid: m[1].trim(), val: val === '0' || val === '' ? ' ' : val, isLeave };
  }

  // Gộp chuỗi sự kiện radio (đã sắp xếp theo thời gian): bỏ log "Rời kênh" ảo đến <= 3s sau khi vào kênh
  collapseRadioEvents(events) {
    const local = new Map();
    for (const e of events) {
      const last = local.get(e.pid);
      if (last && e.isLeave && (e.time - last.time) / 1000 <= 3 && last.val !== ' ') continue;
      local.set(e.pid, { val: e.val, time: e.time });
    }
    return local;
  }

  // ==========================================
  // CÒI BÁO ĐỘNG SĨ QUAN LẠ
  // ==========================================
  async alertUnknownOfficers(latestDuty, existingPids, newOfficers) {
    const vp = this.bot.channels.cache.get(alertRoom('VP_MOMO_LA'));
    if (!vp) return;
    const pings = `${roleMention(vp.guild, 'Sở Trưởng Cảnh Sát')} ${roleMention(vp.guild, 'Sở Phó Cảnh Sát')}`;
    const now = Date.now();

    for (const [pid, status] of latestDuty) {
      if (status !== 'Đang Onduty' || existingPids.has(pid)) continue;
      const last = this.alertedUnknownPids.get(pid);
      if (last && now - last < 4 * HOUR_MS) continue;
      this.alertedUnknownPids.set(pid, now);

      const t = newOfficers.get(pid)?.time;
      const timeStr = fmt(t ? toVN(t) : nowVN(), 'HH:mm:ss DD/MM/YYYY');
      await vp.send(
        `🚨 ${pings}\nPhát hiện số momo là **${pid}** không có trong Danh sách Cảnh sát hiện tại vừa OnDuty vào lúc **${timeStr}**. Cần xác minh thông tin thực tế.`,
      );
    }
  }

  // Ghi trạng thái Duty/Radio mới nhất lên sheet Online (dùng chung cho bus 10s và radar 5 phút)
  async applyToSheet(latestDuty, latestRadio, newOfficers) {
    const allRows = await this.bot.sheets.online.getAllValues();
    const cells = [];
    const existing = new Set();

    allRows.forEach((row, idx) => {
      if (row.length < 3) return;
      const pid = S(row[2]);
      if (!pid) return;
      existing.add(pid);

      const oldDuty = row.length >= 8 ? S(row[7]) : '';
      const oldRadio = row.length >= 9 ? S(row[8]) : '';
      const curDuty = latestDuty.has(pid) ? latestDuty.get(pid) : oldDuty;

      if (latestDuty.has(pid) && curDuty !== oldDuty) cells.push(cell(idx + 1, 8, curDuty));

      let targetRadio;
      if (curDuty === ' ') targetRadio = ' ';
      else if (latestRadio.has(pid)) targetRadio = latestRadio.get(pid);
      else if (latestDuty.has(pid) && curDuty === 'Đang Onduty') targetRadio = this.lastRadioActions[pid]?.val ?? ' ';
      else targetRadio = oldRadio;

      if (targetRadio !== oldRadio) cells.push(cell(idx + 1, 9, targetRadio));
    });

    await this.alertUnknownOfficers(latestDuty, existing, newOfficers);
    if (cells.length) await this.bot.sheets.online.updateCells(cells);
  }

  // ==========================================
  // CỖ MÁY 1: TRẠM XE BUÝT 10 GIÂY
  // ==========================================
  async batchProcessor() {
    if (!this.dutyQueue.length && !this.radioQueue.length) return;

    const latestDuty = new Map();
    const latestRadio = new Map();
    const newOfficers = new Map();
    let changed = false;

    for (const item of this.dutyQueue.splice(0)) {
      latestDuty.set(item.pid, item.status);
      newOfficers.set(item.pid, { time: item.time });
    }

    for (const item of this.radioQueue.splice(0)) {
      const last = this.lastRadioActions[item.pid];
      if (last && item.isLeave && (item.time - last.time) / 1000 <= 3 && last.val !== ' ') continue;
      this.lastRadioActions[item.pid] = { val: item.val, time: item.time };
      latestRadio.set(item.pid, item.val);
      changed = true;
    }
    if (changed) this.saveMemory();

    try {
      await this.applyToSheet(latestDuty, latestRadio, newOfficers);
    } catch (e) {
      console.error('❌ Lỗi Bus Nhân Sự:', e.message);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message) || !message.embeds.length) return;

    if (message.channel.id === ROOMS.DUTY) {
      for (const embed of message.embeds) {
        const d = this.parseDutyEmbed(embed);
        if (d) this.dutyQueue.push({ ...d, time: message.createdAt });
      }
    } else if (message.channel.id === ROOMS.RADIO) {
      for (const embed of message.embeds) {
        const r = this.parseRadioEmbed(embed);
        if (r) this.radioQueue.push({ ...r, time: new Date() });
      }
    }
  }

  // ==========================================
  // CỖ MÁY 2: RADAR KÉP 5 PHÚT (quét lại 6 phút gần nhất, chống sót)
  // ==========================================
  async periodicCheck() {
    try {
      const dutyCh = this.bot.channels.cache.get(ROOMS.DUTY);
      const radioCh = this.bot.channels.cache.get(ROOMS.RADIO);
      if (!dutyCh || !radioCh) return;

      const threshold = Date.now() - 6 * 60_000;
      const latestDuty = new Map();
      const latestRadio = new Map();
      const newOfficers = new Map();

      const scanDuty = async () => {
        for await (const msg of history(dutyCh, { limit: 500 })) {
          if (msg.createdTimestamp < threshold) break;
          for (const embed of msg.embeds) {
            const d = this.parseDutyEmbed(embed);
            if (d && !latestDuty.has(d.pid)) {
              latestDuty.set(d.pid, d.status);
              newOfficers.set(d.pid, { time: msg.createdAt });
            }
          }
        }
      };

      const scanRadio = async () => {
        const events = [];
        for await (const msg of history(radioCh, { limit: 500 })) {
          if (msg.createdTimestamp < threshold) break;
          for (const embed of msg.embeds) {
            const r = this.parseRadioEmbed(embed);
            if (r) events.push({ ...r, time: msg.createdAt });
          }
        }
        events.sort((a, b) => a.time - b.time);
        let changed = false;
        for (const [pid, v] of this.collapseRadioEvents(events)) {
          latestRadio.set(pid, v.val);
          const last = this.lastRadioActions[pid];
          if (!last || v.time > last.time) {
            this.lastRadioActions[pid] = { val: v.val, time: v.time };
            changed = true;
          }
        }
        if (changed) this.saveMemory();
      };

      await Promise.all([scanDuty(), scanRadio()]);
      if (!latestDuty.size && !latestRadio.size) return;
      await this.applyToSheet(latestDuty, latestRadio, newOfficers);
    } catch (e) {
      console.error('Lỗi Radar Kép:', e.message);
    }
  }

  // Đọc tham số ngày cho !updateduty / !updateradio. Mặc định 24h qua.
  async parseRange(ctx, fromStr, toStr, label, cmd) {
    const now = nowVN();
    if (!fromStr) {
      await ctx.send(`⏳ **Radar quét bù ${label} 24h qua đang chạy...**\n*(Mẹo: Sếp có thể quét theo ngày: \`!${cmd} 01/10/2026 15/10/2026\`)*`);
      return { from: addMs(now, -24 * HOUR_MS), to: now };
    }
    const from = parseDMY(fromStr);
    const toDay = toStr ? parseDMY(toStr) : now;
    if (!from || !toDay) {
      await ctx.send(`❌ **Sai định dạng!** Vui lòng nhập chuẩn: \`dd/mm/yyyy\` (Ví dụ: \`!${cmd} 01/10/2026 15/10/2026\`).`);
      return null;
    }
    const to = endOfDay(toDay);
    await ctx.send(`⏳ **Radar khởi động chiến dịch Backfill ${label}...**\n*(Mốc: Từ ${fmt(from, 'DD/MM/YYYY')} đến ${fmt(to, 'DD/MM/YYYY')})*`);
    return { from, to };
  }

  // ==========================================
  // !updateduty [dd/mm/yyyy] [dd/mm/yyyy]
  // ==========================================
  async updateDuty(ctx, fromStr, toStr) {
    if (!hasRole(ctx.author, 'Hội Đồng Ủy Ban')) return ctx.send('❌ KHÔNG CÓ THẨM QUYỀN!');
    const range = await this.parseRange(ctx, fromStr, toStr, 'Duty', 'updateduty');
    if (!range) return;

    try {
      const channel = this.bot.channels.cache.get(ROOMS.DUTY);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh Log Duty!');

      const finalStates = new Map();
      for await (const msg of history(channel, { limit: null, after: vnToUtc(range.from), before: vnToUtc(range.to), oldestFirst: true })) {
        for (const embed of msg.embeds) {
          const d = this.parseDutyEmbed(embed);
          if (d) finalStates.set(d.pid, d.status);
        }
      }
      if (!finalStates.size) return ctx.send('📭 Không có dữ liệu chấm công trong khoảng thời gian này.');

      const allRows = await this.bot.sheets.online.getAllValues();
      const cells = [];
      allRows.forEach((row, idx) => {
        if (row.length < 3) return;
        const pid = S(row[2]);
        if (!pid || !finalStates.has(pid)) return;
        const oldDuty = row.length >= 8 ? S(row[7]) : '';
        const oldRadio = row.length >= 9 ? S(row[8]) : '';
        const newDuty = finalStates.get(pid);
        if (newDuty !== oldDuty) cells.push(cell(idx + 1, 8, newDuty));
        if (newDuty === ' ') {
          if (oldRadio !== ' ') cells.push(cell(idx + 1, 9, ' '));
        } else if (newDuty === 'Đang Onduty') {
          const restored = this.lastRadioActions[pid]?.val ?? ' ';
          if (restored !== ' ' && restored !== oldRadio) cells.push(cell(idx + 1, 9, restored));
        }
      });

      if (cells.length) await this.bot.sheets.online.updateCells(cells);
      await ctx.send(`✅ Đã đồng bộ xong dữ liệu Duty cho **${finalStates.size}** Sĩ quan (Chỉ GHI ĐÈ những người có sẵn trên Sheet).`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // !updateradio [dd/mm/yyyy] [dd/mm/yyyy]
  // ==========================================
  async updateRadio(ctx, fromStr, toStr) {
    if (!hasRole(ctx.author, 'Hội Đồng Ủy Ban')) return ctx.send('❌ KHÔNG CÓ THẨM QUYỀN!');
    const range = await this.parseRange(ctx, fromStr, toStr, 'Radio', 'updateradio');
    if (!range) return;

    try {
      const channel = this.bot.channels.cache.get(ROOMS.RADIO);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh Log Radio!');

      const events = [];
      for await (const msg of history(channel, { limit: null, after: vnToUtc(range.from), before: vnToUtc(range.to), oldestFirst: true })) {
        for (const embed of msg.embeds) {
          const r = this.parseRadioEmbed(embed);
          if (r) events.push({ ...r, time: msg.createdAt });
        }
      }
      if (!events.length) return ctx.send('📭 Không có dữ liệu Radio trong khoảng thời gian này.');

      events.sort((a, b) => a.time - b.time);
      const local = this.collapseRadioEvents(events);

      let changed = false;
      for (const [pid, v] of local) {
        const last = this.lastRadioActions[pid];
        if (!last || v.time > last.time) {
          this.lastRadioActions[pid] = { val: v.val, time: v.time };
          changed = true;
        }
      }
      if (changed) this.saveMemory();

      const allRows = await this.bot.sheets.online.getAllValues();
      const cells = [];
      allRows.forEach((row, idx) => {
        if (row.length < 3) return;
        const pid = S(row[2]);
        if (!local.has(pid)) return;
        const oldDuty = row.length >= 8 ? S(row[7]) : '';
        const oldRadio = row.length >= 9 ? S(row[8]) : '';
        const val = local.get(pid).val;
        if (oldDuty === 'Đang Onduty' && val !== oldRadio) cells.push(cell(idx + 1, 9, val));
      });

      if (cells.length) await this.bot.sheets.online.updateCells(cells);
      await ctx.send(`✅ Đã đồng bộ Radio xong cho **${local.size}** Sĩ quan (Chỉ GHI ĐÈ những người có sẵn trên Sheet).`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }
}
