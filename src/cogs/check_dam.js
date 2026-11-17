import fs from 'node:fs';
import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, alertRoom } from '../config.js';
import {
  S, cell, nowVN, fmt, addMs, DAY_MS, weekday, COLORS, hasRole, isBotAdmin, roleMention, csToMemberMap, history, cleanRadio, sendTemp, NO_PERM,
} from '../utils.js';

const IMMUNE_MOMO = ['23', '12678', '12510', '3840', '20444']; // Không lưu data
const NO_PING_MOMO = ['281', '3466', '200']; // Đặc quyền không bị ping
const HIDDEN_MOMO = ['3466']; // Ẩn khỏi bảng hiển thị
const HIDDEN_CALLSIGN = ['281'];
const PRIMARY_RADIOS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '113'];
const ROLE_113_RE = /\b(CSV|DT|CSVDB)\b/;
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
      console.log('💾 [Check Dam] Đã nạp thành công dữ liệu trí nhớ từ Ổ cứng!');
    } catch (e) {
      console.error('Lỗi đọc file trí nhớ:', e.message);
    }
  }

  saveMemory() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.radioMemory, null, 4), 'utf8');
    } catch (e) {
      console.error('Lỗi lưu file trí nhớ:', e.message);
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
          console.log(`🔄 Đã chuyển data 113: ${existingCs} -> ${cs} (Momo: ${momo})`);
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
      console.error('Lỗi Sync:', e.message);
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
        console.log(`🧹 [Thợ Săn Bóng Ma] Đã đá văng ${kick} Sĩ quan treo máy/crash game quá 12h.`);
      }
    } catch (e) {
      console.error('Lỗi Auto Kick 12h:', e.message);
    }
  }

  // ==========================================
  // !updatechucvu - đồng bộ chức vụ từ GCPD HOME vào bộ nhớ
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
      if (!ROLE_113_RE.test(d.role ?? '')) continue;
      if ((d[key] ?? 0) > 0) list.push({ cs, name: d.name, momo, mins: d[key] });
    }
    return list.sort((a, b) => b.mins - a.mins);
  }

  renderTop(list, medals, csMap) {
    let t = '';
    list.forEach((u, i) => {
      const mb = csMap.get(u.cs);
      const mention = mb ? mb.toString() : `${u.cs} | ${u.name}`;
      t += `${medals[i]} **${mention}** - \`${this.formatTime(u.mins)}\`\n`;
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
    const csMap = csToMemberMap(guild);
    const top3 = this.renderTop(this.rankList('daily_113_mins').slice(0, 3), MEDAL_3, csMap) + '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const top10 = this.renderTop(this.rankList('weekly_113_mins').slice(0, 10), MEDAL_10, csMap);
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
    const csMap = csToMemberMap(guild);
    const top10 = this.renderTop(this.rankList('weekly_113_mins').slice(0, 10), MEDAL_10, csMap);
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
  async buildRadioReport(guild, isAuto = false) {
    const allRows = await this.fetchSheetData();
    const csMap = csToMemberMap(guild);
    const ondutyRads = new Map();
    const noRadDisp = [];
    const pings = [];
    let total = 0;

    for (let idx = 1; idx < allRows.length; idx++) {
      const row = allRows[idx];
      if (row.length < 9) continue;
      const cs = S(row[1]);
      const momo = S(row[2]);
      const ten = S(row[3]);
      const duty = S(row[7]).toLowerCase();
      const radio = cleanRadio(row[8]);

      if (!cs || this.isImmune(cs, momo) || this.isHidden(cs, momo)) continue;
      if (duty !== 'đang onduty') continue;

      total++;
      let tInf = '';
      let hInf = '';
      const m = this.radioMemory[cs];
      if (m) {
        if (m.current) tInf = this.getDurationStr(m.current.start);
        if (m.history?.length) {
          const h = m.history.slice(-3).map((x) => (x.radio === '0' ? `Không đàm (${x.duration})` : `Đàm ${x.radio} (${x.duration})`));
          hInf = ` | 📻 LS: ${h.join(', ')}`;
        }
      }

      if (!radio || radio === '0') {
        if (this.isNoPing(cs, momo)) continue;
        const disp = `• **${cs} | ${momo} | ${ten}**\n└> ❌ Chưa vào đàm | ⏱️ ${tInf}${hInf}`;
        const mb = csMap.get(cs);
        if (mb) {
          pings.push(mb.toString());
          noRadDisp.push(disp);
        } else {
          noRadDisp.push(disp + ' *(Chưa khớp Discord)*');
        }
      } else {
        const disp = `• **${cs} | ${momo} | ${ten}**\n└> ⏳ Đang trực: ${tInf}${hInf}`;
        if (!ondutyRads.has(radio)) ondutyRads.set(radio, []);
        ondutyRads.get(radio).push(disp);
      }
    }

    const title = `📡 Kênh đàm hiện tại (${total} người onduty)`;
    const lines = ['🟢 **OnDuty**\n'];
    const sortKey = (k) => (/^\d+$/.test(k.replace(/\./g, '')) ? parseFloat(k) : 999);
    for (const r of [...ondutyRads.keys()].sort((a, b) => sortKey(a) - sortKey(b))) {
      lines.push(`**Đàm ${r}** (${ondutyRads.get(r).length})`);
      lines.push(...ondutyRads.get(r));
      lines.push('');
    }
    if (!ondutyRads.size) lines.push('*(Trống)*\n');
    lines.push(`🚫 **Onduty không vào đàm** (${noRadDisp.length})`);
    if (noRadDisp.length) lines.push(...noRadDisp);
    else lines.push('*(Sạch)*');

    const embeds = [];
    let chunk = '';
    let curTitle = title;
    for (const line of lines) {
      if (chunk.length + line.length + 2 > 4000) {
        embeds.push(new EmbedBuilder().setTitle(curTitle).setColor(COLORS.blue).setDescription(chunk));
        curTitle = title + ' (tiếp)';
        chunk = line + '\n';
      } else {
        chunk += line + '\n';
      }
    }
    if (chunk) embeds.push(new EmbedBuilder().setTitle(curTitle).setColor(COLORS.blue).setDescription(chunk));

    let content = '';
    if (isAuto) content += `ℹ️ Kiểm tra kênh đàm lúc **${fmt(nowVN(), 'HH:mm')}**\n`;
    if (pings.length) content += `⚠️ Vào đàm: ${pings.join(', ')}`;
    else if (!isAuto) content = '✅ Mọi người đều đang trong đàm.';

    return { content: content.slice(0, 1950), embeds };
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
      console.error('Lỗi auto_radio:', e.message);
    }
  }

  // ==========================================
  // !add113 / !sub113 <callsign|momo> <phút>
  // ==========================================
  async adjust113(ctx, identifier, minutesStr, mode) {
    // FIX: bản Python ở sub113 gõ nhầm tên role "S Sở Trưởng Cảnh Sát"
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);
    if (!identifier || !/^-?\d+$/.test(minutesStr ?? '')) {
      return ctx.send(`⚠️ Cú pháp: \`!${mode}113 <callsign|momo> <số phút>\``);
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

      const chVp = this.bot.channels.cache.get(alertRoom('VP_DAM'));
      if (chVp) {
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
          const pings = `${roleMention(chVp.guild, 'Sở Trưởng Cảnh Sát')} ${roleMention(chVp.guild, 'Sở Phó Cảnh Sát')}`;
          let desc = '';
          top10.forEach((u, i) => {
            const det = Object.entries(u.details).map(([rad, m]) => `${rad} (${this.formatTime(m)})`);
            desc += `**#${i + 1}. ${u.cs} | ${u.momo} | ${u.name}** - Tổng: \`${this.formatTime(u.mins)}\`\n└> Chi tiết: ${det.join(', ')}\n\n`;
          });
          const embed = new EmbedBuilder()
            .setTitle(`🚨 Vi phạm đàm ${fmt(now, 'DD/MM/YYYY')}`)
            .setDescription(
              `Top 10 onduty ngoài đàm chính (1-9, 113), tính cả không vào đàm.\n\n${desc}`.slice(0, 4096),
            )
            .setColor(COLORS.red)
            .setFooter({ text: 'GCPD Check đàm' });
          await chVp.send({ content: pings, embeds: [embed] });
        }
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
      console.error('Lỗi Tổng Kết Cuối Ngày:', e.message);
    }
  }

  // ==========================================
  // MẮT THẦN 113 (mỗi phút): đàm 113 trống / quá tải
  // ==========================================
  async eyeOf113() {
    try {
      const channel = this.bot.channels.cache.get(ROOMS.CHECK_DAM);
      const topChannel = this.bot.channels.cache.get(ROOMS.TOP_113);
      if (!channel) return;

      const allRows = await this.fetchSheetData();
      let count113 = 0;
      const pingsNoRadio = [];
      const team113 = [];
      const allOnduty = [];
      const cur113Momos = [];
      const in113Pings = [];
      const csMap = csToMemberMap(channel.guild);

      for (let idx = 1; idx < allRows.length; idx++) {
        const row = allRows[idx];
        if (row.length < 9) continue;
        const cs = S(row[1]);
        const momo = S(row[2]);
        const chucVu = S(row[6]).toUpperCase();
        const duty = S(row[7]).toLowerCase();
        const radio = cleanRadio(row[8]);

        if (!cs || this.isImmune(cs, momo)) continue;
        if (duty !== 'đang onduty') continue;

        const mb = csMap.get(cs);
        if (radio === '113') {
          count113++;
          cur113Momos.push(momo);
          if (this.isNoPing(cs, momo) || !mb) in113Pings.push(`**${cs}**`);
          else in113Pings.push(mb.toString());
        }

        if (mb && !this.isNoPing(cs, momo)) {
          if (!radio || radio === '0') pingsNoRadio.push(mb.toString());
          allOnduty.push(mb.toString());
          if (chucVu.includes('113') || chucVu.includes('GS113')) team113.push(mb.toString());
        }
      }
      cur113Momos.sort();

      // Báo động 113 trống 5 phút
      if (count113 === 0) {
        this.empty113Minutes++;
        if (this.empty113Minutes >= 5) {
          let pingsStr, note;
          if (team113.length) [pingsStr, note] = [team113.join(' '), '*(Team 113 đang onduty)*'];
          else if (allOnduty.length) [pingsStr, note] = [allOnduty.join(' '), '*(Không có team 113, người onduty vào hỗ trợ)*'];
          else [pingsStr, note] = ['', '*(Không ai onduty)*'];

          let msg = `🚨 **ĐÀM 113 TRỐNG**\nKhông ai trực đàm 113 trong 5 phút qua.\nGọi: ${pingsStr}\n${note}\n`;
          if (pingsNoRadio.length) msg += `\nOnduty chưa vào đàm: ${pingsNoRadio.join(', ')}`;
          await sendTemp(channel, msg.length > 2000 ? msg.slice(0, 1990) + '...*' : msg, 300_000);
          this.empty113Minutes = 0;
        }
      } else {
        this.empty113Minutes = 0;
      }

      // Báo động quá tải: >= 5 người, cùng 1 nhóm, liên tục 30 phút
      if (count113 >= 5) {
        if (JSON.stringify(this.overload.momos) === JSON.stringify(cur113Momos)) {
          this.overload.minutes++;
          if (this.overload.minutes >= 30) {
            if (topChannel) {
              await topChannel.send(
                `🚨 **ĐÀM 113 QUÁ TẢI**\nCùng **${count113}** người ở đàm 113 liên tục hơn 30 phút: ${in113Pings.join(', ')}\nVui lòng tuân thủ quy định số người trong đàm 113.`,
              );
            }
            this.overload.minutes = 0;
          }
        } else {
          this.overload = { momos: cur113Momos, minutes: 1 };
        }
      } else {
        this.overload = { momos: [], minutes: 0 };
      }
    } catch (e) {
      console.error('Lỗi eye_113:', e.message);
    }
  }
}
