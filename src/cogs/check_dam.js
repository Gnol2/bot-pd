import fs from 'node:fs';
import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, DIEU_DAM_RANKS } from '../config.js';
import { sendViolation } from '../violation.js';
import {
  S, cell, nowVN, fmt, addMs, DAY_MS, weekday, COLORS, hasRole, isBotAdmin, csToMemberMap, history, cleanRadio, NO_PERM,
} from '../utils.js';

const IMMUNE_MOMO = ['23', '12678', '12510', '3840', '20444', '102']; // Không lưu data
const NO_PING_MOMO = []; // Đặc quyền không bị ping
const HIDDEN_MOMO = []; // Ẩn khỏi bảng hiển thị
const HIDDEN_CALLSIGN = [];
const PRIMARY_RADIOS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '113'];
const MEMORY_FILE = 'radio_memory.json';
const MEDAL_3 = ['🥇', '🥈', '🥉'];
const MEDAL_10 = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const HISTORY_KEEP = 20; // Chỉ hiển thị 3 mục gần nhất, giữ 20 để file không phình vô hạn

const newMem = (momo, name, role = '') => ({
  current: null,
  history: [],
  last_off_radio: null,
  daily_113_mins: 0,
  weekly_113_mins: 0,
  daily_vi_pham_mins: 0,
  weekly_vi_pham_mins: 0,
  vi_pham_details: {},
  momo,
  name,
  role,
});

// Giám sát đàm: tính giờ 113, vi phạm đàm, báo cáo kênh đàm, báo động 113, tổng kết cuối ngày
export default class CheckDam extends Cog {
  constructor(bot) {
    super(bot);
    this.empty113Minutes = 0;
    this.overload = { momos: [], minutes: 0 };
    this.lastAutoRadioMsgIds = [];
    this.sheetCache = [];
    this.lastCacheTime = 0;
    this.radioMemory = {};
    this.loadMemory();

    this.commands = {
      updatechucvu: (ctx) => this.updateChucVu(ctx),
      top113: (ctx) => this.top113(ctx),
      top113tuan: (ctx) => this.top113Tuan(ctx),
      radio: (ctx) => this.radioCmd(ctx),
      add113: (ctx, id, m) => this.adjust113(ctx, id, m, 'add'),
      sub113: (ctx, id, m) => this.adjust113(ctx, id, m, 'sub'),
    };

    this.loop('sync_radio_history', 60_000, () => this.syncRadioHistory());
    this.loop('eye_of_113', 60_000, () => this.eyeOf113());
    this.loop('auto_radio_report', 5 * 60_000, () => this.autoRadioReport(), {
      before: async () => {
        // Căn cho chạy đúng các mốc phút chia hết cho 5
        const now = nowVN();
        let s = (5 - (now.getUTCMinutes() % 5)) * 60 - now.getUTCSeconds();
        if (s <= 0) s = 300;
        await this.sleep(s * 1000);
      },
    });
    this.loop('auto_kick_12h_ghosts', 30 * 60_000, () => this.autoKick12hGhosts(), {
      before: () => this.sleep(60_000),
    });
    // 23:59 VN = 16:59 UTC
    this.dailyAtUTC('daily_final_tasks', 16, 59, () => this.dailyFinalTasks());
  }

  // ==========================================
  // TIỆN ÍCH
  // ==========================================
  isImmune(cs, momo) {
    return IMMUNE_MOMO.includes(momo) || IMMUNE_MOMO.includes(cs);
  }
  isHidden(cs, momo) {
    return HIDDEN_MOMO.includes(momo) || HIDDEN_CALLSIGN.includes(cs);
  }
  isNoPing(cs, momo) {
    return NO_PING_MOMO.includes(momo) || NO_PING_MOMO.includes(cs);
  }

  formatTime(total) {
    if (total <= 0) return '0p';
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h${m}p` : `${m}p`;
  }

  getDurationStr(start) {
    if (!start) return '0p';
    const sec = Math.trunc((nowVN() - new Date(start)) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}p` : `${m}p`;
  }

  extractFullText(embed) {
    const parts = [String(embed.title ?? ''), String(embed.description ?? '')];
    if (embed.author?.name) parts.push(String(embed.author.name));
    for (const f of embed.fields ?? []) parts.push(`${f.name} ${f.value}`);
    return parts.join(' ').replace(/[*`]/g, '').toUpperCase();
  }

  async fetchSheetData() {
    if (this.sheetCache.length && Date.now() - this.lastCacheTime < 45_000) return this.sheetCache;
    this.sheetCache = await this.bot.sheets.online.getAllValues();
    this.lastCacheTime = Date.now();
    return this.sheetCache;
  }

  pushHistory(mem) {
    mem.history.push({ radio: mem.current.radio, duration: this.getDurationStr(mem.current.start) });
    if (mem.history.length > HISTORY_KEEP) mem.history.splice(0, mem.history.length - HISTORY_KEEP);
  }

  // ==========================================
  // BỘ NHỚ Ổ CỨNG (tương thích file radio_memory.json của bản Python)
  // ==========================================
  loadMemory() {
    if (!fs.existsSync(MEMORY_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      for (const mem of Object.values(data)) {
        if (mem.current?.start) mem.current.start = new Date(mem.current.start);
        if (mem.last_off_radio) mem.last_off_radio = new Date(mem.last_off_radio);
        if ('total_113_mins' in mem) {
          mem.weekly_113_mins = mem.total_113_mins;
          delete mem.total_113_mins;
          mem.daily_113_mins = mem.weekly_113_mins;
          mem.weekly_vi_pham_mins = mem.total_vi_pham_mins ?? 0;
          delete mem.total_vi_pham_mins;
          mem.daily_vi_pham_mins = mem.weekly_vi_pham_mins;
        }
        mem.daily_113_mins ??= 0;
        mem.weekly_113_mins ??= 0;
        mem.daily_vi_pham_mins ??= 0;
        mem.weekly_vi_pham_mins ??= 0;
        mem.vi_pham_details ??= {};
        mem.role ??= '';
        mem.history ??= [];
      }
      this.radioMemory = data;
      console.log('[Dam] Đã nạp dữ liệu đàm đã lưu');
    } catch (e) {
      console.error('[Dam] LỖI đọc file lưu:', e.message);
    }
  }

  saveMemory() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.radioMemory, null, 4), 'utf8');
    } catch (e) {
      console.error('[Dam] LỖI ghi file lưu:', e.message);
    }
  }

  // ==========================================
  // CỖ MÁY 1: TÍNH GIỜ ĐÀM (mỗi phút)
  // ==========================================
  async syncRadioHistory() {
    try {
      const allRows = await this.fetchSheetData();
      const now = nowVN();
      const toClear = [];

      for (let idx = 1; idx < allRows.length; idx++) {
        const row = allRows[idx];
        if (row.length < 9) continue;

        const cs = S(row[1]);
        const momo = S(row[2]);
        const name = S(row[3]);
        const role = row.length > 4 ? S(row[4]).toUpperCase() : ''; // Cột E: Chức vụ
        const duty = S(row[7]).toLowerCase();
        let radio = cleanRadio(row[8]);

        if (!cs || this.isImmune(cs, momo)) continue;

        if (duty !== 'đang onduty' && radio) {
          toClear.push(cell(idx + 1, 9, ''));
          radio = '';
        }

        let existingCs = null;
        for (const [k, v] of Object.entries(this.radioMemory)) {
          if (v.momo === momo) {
            existingCs = k;
            break;
          }
        }
        if (existingCs && existingCs !== cs) {
          this.radioMemory[cs] = this.radioMemory[existingCs];
          delete this.radioMemory[existingCs];
          this.radioMemory[cs].name = name;
          this.radioMemory[cs].role = role;
          console.log(`[Dam] Đổi callsign dữ liệu 113: ${existingCs} -> ${cs} (momo ${momo})`);
        }

        if (!(cs in this.radioMemory)) this.radioMemory[cs] = newMem(momo, name, role);
        else if (role) this.radioMemory[cs].role = role;

        const mem = this.radioMemory[cs];
        const actual = radio && radio !== '0' ? radio : '0';

        if (duty === 'đang onduty') {
          if (actual === '113') {
            mem.daily_113_mins += 1;
            mem.weekly_113_mins += 1;
          }
          if (!PRIMARY_RADIOS.includes(actual) && !this.isNoPing(cs, momo)) {
            mem.daily_vi_pham_mins += 1;
            mem.weekly_vi_pham_mins += 1;
            const rn = actual === '0' ? 'Chưa vào đàm' : `Đàm ${actual}`;
            mem.vi_pham_details[rn] = (mem.vi_pham_details[rn] ?? 0) + 1;
          }
          if (!mem.current || mem.current.radio !== actual) {
            if (mem.current) this.pushHistory(mem);
            mem.current = { radio: actual, start: now };
            mem.last_off_radio = null;
          }
        } else if (mem.current) {
          this.pushHistory(mem);
          mem.current = null;
          mem.last_off_radio = now;
        } else if (!mem.last_off_radio) {
          mem.last_off_radio = now;
        }
      }

      if (toClear.length) await this.bot.sheets.online.updateCells(toClear);
      this.saveMemory();
    } catch (e) {
      console.error('[Dam] LỖI đồng bộ Online:', e.message);
    }
  }

  // ==========================================
  // CỖ MÁY 2: THỢ SĂN BÓNG MA (treo duty > 12h -> đá)
  // ==========================================
  async autoKick12hGhosts() {
    try {
      const dutyChannel = this.bot.channels.cache.get(ROOMS.DUTY);
      if (!dutyChannel) return;

      const nowMs = Date.now();
      const threshold = nowMs - DAY_MS;
      const latest = new Map();

      const allRows = await this.fetchSheetData();
      const onDuty = new Set(allRows.filter((r) => r.length >= 8 && S(r[7]) === 'Đang Onduty').map((r) => S(r[2])));
      if (!onDuty.size) return;

      for await (const msg of history(dutyChannel, { limit: 3000 })) {
        if (msg.createdTimestamp < threshold) break;
        for (const embed of msg.embeds) {
          const etc = this.extractFullText(embed);
          const isOn = etc.includes('ON DUTY') || etc.includes('10-41');
          const isOff = etc.includes('OFF DUTY') || etc.includes('10-42');
          if (!isOn && !isOff) continue;
          const m = /(?:PLAYER\s*ID|ID)[\s:]*(\d+)/.exec(etc);
          if (m && onDuty.has(m[1].trim()) && !latest.has(m[1].trim())) {
            latest.set(m[1].trim(), { status: isOn ? 'ON' : 'OFF', time: msg.createdTimestamp });
          }
        }
      }

      const cells = [];
      let kick = 0;
      allRows.forEach((row, idx) => {
        if (row.length < 8 || S(row[7]) !== 'Đang Onduty') return;
        const l = latest.get(S(row[2]));
        const shouldKick = !l || l.status === 'OFF' || nowMs - l.time > 12 * 3600_000;
        if (shouldKick) {
          cells.push(cell(idx + 1, 8, ' '), cell(idx + 1, 9, ' '));
          kick++;
        }
      });

      if (cells.length) {
        await this.bot.sheets.online.updateCells(cells);
        console.log(`[Dam] Tự OFF ${kick} người treo duty quá 12h`);
      }
    } catch (e) {
      console.error('[Dam] LỖI tự OFF 12h:', e.message);
    }
  }

  // ==========================================
  // /updatechucvu - đồng bộ chức vụ từ GCPD HOME vào bộ nhớ
  // ==========================================
  async updateChucVu(ctx) {
    const a = ctx.author;
    if (!isBotAdmin(a)) return ctx.send(NO_PERM);
    const msg = await ctx.send('⏳ Đang đồng bộ chức vụ từ GCPD HOME...');
    try {
      const gcpd = await this.bot.sheets.role.getAllValues();
      const momoToRole = new Map();
      for (const row of gcpd) {
        if (row.length >= 5) {
          const m = S(row[2]);
          if (m) momoToRole.set(m, S(row[4]).toUpperCase());
        }
      }
      let updated = 0;
      for (const data of Object.values(this.radioMemory)) {
        const r = momoToRole.get(data.momo ?? '');
        if (r !== undefined && data.role !== r) {
          data.role = r;
          updated++;
        }
      }
      this.saveMemory();
      await msg.edit(`✅ Đã cập nhật chức vụ cho **${updated}** người.`);
    } catch (e) {
      await msg.edit(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // BẢNG VÀNG 113
  // ==========================================
  rankList(key) {
    const list = [];
    for (const [cs, d] of Object.entries(this.radioMemory)) {
      const momo = d.momo ?? '';
      if (this.isHidden(cs, momo)) continue;
      if ((d[key] ?? 0) > 0) list.push({ cs, name: d.name, momo, mins: d[key] });
    }
    return list.sort((a, b) => b.mins - a.mins);
  }

  // Chỉ ghi "callsign - Tên", không tag người
  renderTop(list, medals) {
    let t = '';
    list.forEach((u, i) => {
      t += `${medals[i]} **${u.cs} - ${u.name || '?'}** - \`${this.formatTime(u.mins)}\`\n`;
    });
    return t || '*(Không có dữ liệu)*\n';
  }

  weekRangeStr() {
    const now = nowVN();
    const s = addMs(now, -weekday(now) * DAY_MS);
    const e = addMs(s, 6 * DAY_MS);
    return `${fmt(s, 'DD/MM')} - ${fmt(e, 'DD/MM')}`;
  }

  buildBangVangEmbed(guild) {
    const top3 = this.renderTop(this.rankList('daily_113_mins').slice(0, 3), MEDAL_3) + '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const top10 = this.renderTop(this.rankList('weekly_113_mins').slice(0, 10), MEDAL_10);
    return new EmbedBuilder()
      .setTitle('🏆 Top đàm 113')
      .setColor(COLORS.gold)
      .addFields(
        { name: `Top 3 hôm nay (${fmt(nowVN(), 'DD/MM')})`, value: top3.slice(0, 1024), inline: false },
        { name: `Top 10 tuần (${this.weekRangeStr()})`, value: top10.slice(0, 1024), inline: false },
      )
      .setFooter({ text: 'GCPD Đàm 113' });
  }

  buildTongKetTuanEmbed(guild) {
    const top10 = this.renderTop(this.rankList('weekly_113_mins').slice(0, 10), MEDAL_10);
    return new EmbedBuilder()
      .setTitle(`🏆 Tổng kết đàm 113 tuần (${this.weekRangeStr()})`)
      .setDescription(`Top 10 thời gian trực đàm 113 trong tuần:\n\n${top10}`)
      .setColor(COLORS.gold)
      .setFooter({ text: 'GCPD Đàm 113' });
  }

  async top113(ctx) {
    if (!Object.keys(this.radioMemory).length) return ctx.send('📭 Chưa có dữ liệu trực đàm 113.');
    await ctx.send({ embeds: [this.buildBangVangEmbed(ctx.guild)] });
  }

  async top113Tuan(ctx) {
    if (!Object.keys(this.radioMemory).length) return ctx.send('📭 Chưa có dữ liệu trực đàm 113.');
    await ctx.send({ embeds: [this.buildTongKetTuanEmbed(ctx.guild)] });
  }

  // ==========================================
  // BẢNG THEO DÕI KÊNH ĐÀM
  // ==========================================
  // Lịch sử đổi đàm rút gọn: gộp các lần liền nhau cùng đàm, bỏ lần < 1 phút, lấy 2 lần gần nhất.
  // Vd: "113 (1h13p) → 9 (3p)" (cũ → mới, mũi tên cuối dẫn vào đàm hiện tại)
  shortHistory(history = []) {
    const toMin = (d) => {
      const m = /(?:(\d+)h)?(\d+)p/.exec(String(d ?? ''));
      return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : 0;
    };
    const merged = [];
    for (const h of history.slice(-10)) {
      const mins = toMin(h.duration);
      const last = merged.at(-1);
      if (last && last.radio === h.radio) last.mins += mins;
      else merged.push({ radio: h.radio, mins });
    }
    const recent = merged.filter((h) => h.mins >= 1).slice(-2);
    if (!recent.length) return '';
    return recent.map((h) => `${h.radio === '0' ? 'không đàm' : h.radio} (${this.formatTime(h.mins)})`).join(' → ');
  }

  // Bảng kênh đàm (chỉ hiển thị, không ping ai). guild giữ lại cho tương thích chỗ gọi.
  async buildRadioReport(_guild, isAuto = false) {
    const allRows = await this.fetchSheetData();
    const byRadio = new Map(); // radio -> [dòng]
    const noRadio = [];
    let total = 0;

    for (let idx = 1; idx < allRows.length; idx++) {
      const row = allRows[idx];
      if (row.length < 9) continue;
      const cs = S(row[1]);
      const momo = S(row[2]);
      const ten = S(row[3]).replace(/^[.\s]+/, '') || '?';
      const duty = S(row[7]).toLowerCase();
      const radio = cleanRadio(row[8]);

      if (!cs || this.isImmune(cs, momo) || this.isHidden(cs, momo)) continue;
      if (duty !== 'đang onduty') continue;
      total++;

      const m = this.radioMemory[cs];
      const time = m?.current ? this.getDurationStr(m.current.start) : '?';
      const hist = this.shortHistory(m?.history);
      const histStr = hist ? ` · lịch sử: ${hist}` : '';

      if (!radio || radio === '0') {
        if (this.isNoPing(cs, momo)) continue;
        noRadio.push(`\`${cs}\` ${ten} (${momo}) — đã **${time}**${histStr}`);
      } else {
        if (!byRadio.has(radio)) byRadio.set(radio, []);
        byRadio.get(radio).push(`\`${cs}\` ${ten} — **${time}**${histStr}`);
      }
    }

    // 113 lên đầu, sau đó đàm số tăng dần, đàm lạ cuối cùng
    const order = (k) => (k === '113' ? -1 : /^\d+(\.\d+)?$/.test(k) ? parseFloat(k) : 999);
    const radios = [...byRadio.keys()].sort((a, b) => order(a) - order(b));
    const n113 = byRadio.get('113')?.length ?? 0;

    const lines = [
      `👮 **${total}** onduty · 🚨 **${n113}** ở 113 · ${noRadio.length ? `❌ **${noRadio.length}** chưa vào đàm` : '✅ ai cũng đã vào đàm'}`,
      '',
    ];
    for (const r of radios) {
      const list = byRadio.get(r);
      const warn = PRIMARY_RADIOS.includes(r) ? '' : ' · ⚠️ *ngoài đàm chính*';
      lines.push(`📻 **Đàm ${r}** — ${list.length} người${warn}`, ...list, '');
    }
    if (!radios.length) lines.push('*Chưa ai vào đàm.*', '');
    if (noRadio.length) lines.push(`❌ **Chưa vào đàm** — ${noRadio.length} người`, ...noRadio);

    const title = `📡 Kênh đàm lúc ${fmt(nowVN(), 'HH:mm')}`;
    const color = noRadio.length ? COLORS.red : COLORS.blue;
    const embeds = [];
    let chunk = '';
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 4000) {
        embeds.push(new EmbedBuilder().setTitle(embeds.length ? `${title} (tiếp)` : title).setColor(color).setDescription(chunk));
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) embeds.push(new EmbedBuilder().setTitle(embeds.length ? `${title} (tiếp)` : title).setColor(color).setDescription(chunk));
    embeds.at(-1)?.setFooter({ text: isAuto ? 'Tự cập nhật mỗi 5 phút' : 'GCPD Check đàm' });

    return { content: '', embeds };
  }

  async radioCmd(ctx) {
    if (ctx.channel.id !== ROOMS.CHECK_DAM) return;
    const msg = await ctx.send('⏳ Đang kiểm tra kênh đàm...');
    try {
      const { content, embeds } = await this.buildRadioReport(ctx.guild, false);
      await msg.edit({ content: content || null, embeds: embeds.slice(0, 10) });
      for (let i = 10; i < embeds.length; i += 10) await ctx.send({ embeds: embeds.slice(i, i + 10) });
    } catch (e) {
      await msg.edit(`❌ Lỗi: ${e.message}`);
    }
  }

  async autoRadioReport() {
    try {
      const channel = this.bot.channels.cache.get(ROOMS.CHECK_DAM);
      if (!channel) return;
      const { content, embeds } = await this.buildRadioReport(channel.guild, true);

      for (const id of this.lastAutoRadioMsgIds) {
        try {
          const old = await channel.messages.fetch(id);
          await old.delete();
        } catch {
          /* tin nhắn đã bị xoá */
        }
      }
      this.lastAutoRadioMsgIds = [];

      const first = await channel.send({ content: content || undefined, embeds: embeds.slice(0, 10) });
      this.lastAutoRadioMsgIds.push(first.id);
      for (let i = 10; i < embeds.length; i += 10) {
        const extra = await channel.send({ embeds: embeds.slice(i, i + 10) });
        this.lastAutoRadioMsgIds.push(extra.id);
      }
    } catch (e) {
      console.error('[Dam] LỖI báo cáo kênh đàm:', e.message);
    }
  }

  // ==========================================
  // /add113 / /sub113 <callsign|momo> <phút>
  // ==========================================
  async adjust113(ctx, identifier, minutesStr, mode) {
    // FIX: bản Python ở sub113 gõ nhầm tên role "S Sở Trưởng Cảnh Sát"
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    if (!identifier || !/^-?\d+$/.test(minutesStr ?? '')) {
      return ctx.send(`⚠️ Cú pháp: \`/${mode}113 <callsign|momo> <số phút>\``);
    }
    const minutes = parseInt(minutesStr, 10);

    let targetCs = null;
    if (identifier in this.radioMemory) targetCs = identifier;
    else {
      for (const [cs, mem] of Object.entries(this.radioMemory)) {
        if (mem.momo === identifier) {
          targetCs = cs;
          break;
        }
      }
    }

    if (!targetCs) {
      const wait = await ctx.send(`⏳ Đang tìm **${identifier}** trên Sheet...`);
      const allRows = await this.fetchSheetData();
      for (let idx = 1; idx < allRows.length; idx++) {
        const row = allRows[idx];
        if (row.length < 4) continue;
        const sCs = S(row[1]);
        const sMomo = S(row[2]);
        const sName = S(row[3]);
        if ((identifier === sMomo || identifier === sCs) && sCs && !this.isImmune(sCs, sMomo)) {
          this.radioMemory[sCs] = newMem(sMomo, sName, '');
          targetCs = sCs;
          break;
        }
      }
      if (!targetCs) {
        return wait.edit(`❌ Không tìm thấy callsign/momo **${identifier}**.`);
      }
      await wait.delete().catch(() => {});
    }

    const mem = this.radioMemory[targetCs];
    if (mode === 'add') {
      mem.weekly_113_mins += minutes;
      this.saveMemory();
      await ctx.send(`✅ Đã cộng **${minutes}** phút đàm 113 (tuần) cho **${targetCs} | ${mem.momo}**.`);
    } else {
      const newMins = Math.max(0, (mem.weekly_113_mins ?? 0) - minutes);
      mem.weekly_113_mins = newMins;
      this.saveMemory();
      await ctx.send(
        `✅ Đã trừ **${minutes}** phút đàm 113 (tuần) của **${targetCs} | ${mem.momo}**. Còn: **${newMins}p**.`,
      );
    }
  }

  // ==========================================
  // TỔNG KẾT CUỐI NGÀY (23:59 VN)
  // ==========================================
  async dailyFinalTasks() {
    try {
      const now = nowVN();
      if (!Object.keys(this.radioMemory).length) return;
      const isSunday = weekday(now) === 6;

      const ch113 = this.bot.channels.cache.get(ROOMS.TOP_113);
      if (ch113) {
        const embed = isSunday ? this.buildTongKetTuanEmbed(ch113.guild) : this.buildBangVangEmbed(ch113.guild);
        await ch113.send({ embeds: [embed] });
      }

      const vpList = [];
      for (const [cs, d] of Object.entries(this.radioMemory)) {
        const momo = d.momo ?? '';
        if (this.isHidden(cs, momo)) continue;
        if ((d.daily_vi_pham_mins ?? 0) > 0) {
          vpList.push({ cs, name: d.name, momo, mins: d.daily_vi_pham_mins, details: d.vi_pham_details ?? {} });
        }
      }
      vpList.sort((a, b) => b.mins - a.mins);
      const top10 = vpList.slice(0, 10);

      if (top10.length) {
        let desc = '';
        top10.forEach((u, i) => {
          const det = Object.entries(u.details).map(([rad, m]) => `${rad} (${this.formatTime(m)})`);
          desc += `**#${i + 1}. ${u.cs} | ${u.momo} | ${u.name}** - Tổng: \`${this.formatTime(u.mins)}\`\n└> Chi tiết: ${det.join(', ')}\n\n`;
        });
        await sendViolation(
          this.bot,
          'VI_PHAM_DAM',
          `Top 10 onduty ngoài đàm chính (1-9, 113), tính cả không vào đàm.\n\n${desc}`.slice(0, 4096),
          { title: `Vi phạm đàm ${fmt(now, 'DD/MM/YYYY')}`, pingSo: true, time: now },
        );
      }

      // Reset bộ đếm ngày (và tuần nếu là Chủ Nhật), dọn người không còn dữ liệu
      for (const [cs, mem] of Object.entries(this.radioMemory)) {
        mem.daily_113_mins = 0;
        mem.daily_vi_pham_mins = 0;
        mem.vi_pham_details = {};
        if (isSunday) {
          mem.weekly_113_mins = 0;
          mem.weekly_vi_pham_mins = 0;
        }
        if (mem.weekly_113_mins === 0 && mem.weekly_vi_pham_mins === 0 && !mem.current) delete this.radioMemory[cs];
      }
      this.saveMemory();
    } catch (e) {
      console.error('[Dam] LỖI tổng kết cuối ngày:', e.message);
    }
  }

  // ==========================================
  // MẮT THẦN 113 (mỗi phút): đàm 113 trống / quá tải
  // ==========================================
  // Tất cả người onduty thuộc các cấp trong DIEU_DAM_RANKS (cột E), xếp từ cấp cao xuống. Trả về { mentions } hoặc null.
  findDieuDam(onduty) {
    const mentions = DIEU_DAM_RANKS.flatMap((level) =>
      onduty.filter((p) => level.includes(p.role)).map((p) => p.mb?.toString() ?? `**${p.cs}**`),
    );
    return mentions.length ? { mentions } : null;
  }

  // Gửi cảnh báo đàm 113 (embed màu theo loại) vào VI_PHAM, tag các cấp điều đàm đang onduty.
  // tempMs: tự xoá sau N ms (để không dồn tin khi báo lặp lại)
  async sendDieuDam(type, reason, onduty, tempMs) {
    const top = this.findDieuDam(onduty);
    const who = top ? top.mentions.join(' ') : 'cấp quản lý';
    let desc = `🚨 ${reason}\nCác sĩ quan ${who} vui lòng tiến hành điều chuyển 1 cảnh sát viên sang đàm 113 để hỗ trợ người dân.\n**Lưu ý**: Nếu có quá ít PD các bạn có thể ngồi đàm 113 để vừa chạy dispatch vừa hỗ trợ người dân.`;
    if (!top) desc += `\n*(Không có ai từ ${DIEU_DAM_RANKS.at(-1).join('/')} trở lên đang onduty)*`;
    // Tag phải nằm ngoài embed mới ping được -> chỉ đưa các tag <@id> vào nội dung tin
    const pings = (top?.mentions ?? []).filter((m) => m.startsWith('<@'));
    const m = await sendViolation(this.bot, type, desc, { pings });
    if (m && tempMs) setTimeout(() => m.delete().catch(() => {}), tempMs);
  }

  async eyeOf113() {
    try {
      // Cả 2 cảnh báo (trống / quá tải) gửi vào kênh VI_PHAM, ping các cấp điều đàm đang onduty
      const channel = this.bot.channels.cache.get(ROOMS.VI_PHAM);
      if (!channel) return;

      const allRows = await this.fetchSheetData();
      let count113 = 0;
      const cur113Momos = [];
      const in113 = [];
      const onduty = []; // ứng viên điều đàm: { cs, role, mb }
      const csMap = csToMemberMap(channel.guild);

      for (let idx = 1; idx < allRows.length; idx++) {
        const row = allRows[idx];
        if (row.length < 9) continue;
        const cs = S(row[1]);
        const momo = S(row[2]);
        const role = S(row[4]).toUpperCase(); // Cột E: Chức vụ
        const duty = S(row[7]).toLowerCase();
        const radio = cleanRadio(row[8]);

        if (!cs || this.isImmune(cs, momo)) continue;
        if (duty !== 'đang onduty') continue;

        if (radio === '113') {
          count113++;
          cur113Momos.push(momo);
          in113.push(`**${cs}**`);
        }
        if (!this.isNoPing(cs, momo)) onduty.push({ cs, role, mb: csMap.get(cs) });
      }
      cur113Momos.sort();

      // Đàm 113 trống 5 phút liên tục (tin tự xoá sau 5 phút để không dồn tin khi báo lặp lại)
      if (count113 === 0) {
        this.empty113Minutes++;
        if (this.empty113Minutes >= 5) {
          await this.sendDieuDam('DAM_113_TRONG', '**Đàm 113 đang không có người trực** (5 phút liên tục).', onduty, 300_000);
          this.empty113Minutes = 0;
        }
      } else {
        this.empty113Minutes = 0;
      }

      // // Quá số lượng: >= 5 người, cùng 1 nhóm, liên tục 30 phút
      // if (count113 >= 5) {
      //   if (JSON.stringify(this.overload.momos) === JSON.stringify(cur113Momos)) {
      //     this.overload.minutes++;
      //     if (this.overload.minutes >= 30) {
      //       await this.sendDieuDam(
      //         'DAM_113_QUA_TAI',
      //         `**Đàm 113 đang quá số lượng quy định**: **${count113}** người liên tục hơn 30 phút (${in113.join(', ')}).`,
      //         onduty,
      //       );
      //       this.overload.minutes = 0;
      //     }
      //   } else {
      //     this.overload = { momos: cur113Momos, minutes: 1 };
      //   }
      // } else {
      //   this.overload = { momos: [], minutes: 0 };
      // }
    } catch (e) {
      console.error('[Dam] LỖI theo dõi đàm 113:', e.message);
    }
  }
}
