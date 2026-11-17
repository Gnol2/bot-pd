import { EmbedBuilder } from 'discord.js';
import { Cog } from '../core/Cog.js';
import { ROOMS, alertRoom } from '../config.js';
import {
  S, cell, fmt, toVN, nowVN, vnToUtc, addMs, HOUR_MS, endOfDay, parseDMY, parseYMDHMS, uniq, hasRole, roleMention, callsignOf, history, sanitizeVal, COLORS, isBotAdmin, NO_PERM,
} from '../utils.js';

const MAX_EDIT_SECONDS = 6 * 3600; // Tác giả được sửa MDT trong 6 giờ
const EXEMPT_CS = '281'; // S-PGĐ Chú Thanh
const EXEMPT_MOMO = '3466';

const SQ_RE = /Sĩ quan liên quan:\s*\n?([\s\S]*?)(?:\n\s*(?:Dân thường liên quan|Lệnh truy nã|Đã nhận|---)|$)/gi;
const CB_RE = /Cáo buộc:\s*\n?([\s\S]*?)(?:\n\s*(?:Incident ID|Vũ khí|Tội phạm|Phạt tiền|Bản án|Người chơi|Server ID|@|---)|$)/gi;

const stripQuote = (v) => S(String(v).replace(/'/g, ''));

// MDT Incident -> sheet Incident; chặn & báo động sửa MDT không chính chủ
export default class LogIncident extends Cog {
  constructor(bot) {
    super(bot);
    this.queue = [];
    this.alertedKeys = new Set();
    this.commands = { updateincident: (ctx, a, b) => this.updateIncident(ctx, a, b) };
    this.loop('incident_batch_processor', 10_000, () => this.batchProcessor());
    this.loop('auto_scan_incidents', HOUR_MS, () => this.autoScan(), { before: () => this.sleep(15_000) });
  }

  // ==========================================
  // TIỆN ÍCH
  // ==========================================
  mergeSqRelations(oldStr, newStr) {
    const o = oldStr ? String(oldStr).match(/\d+/g) ?? [] : [];
    const n = newStr ? String(newStr).match(/\d+/g) ?? [] : [];
    return uniq([...o, ...n]).join(', ');
  }

  mergeTpIds(oldStr, newStr) {
    const split = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
    return uniq([...split(oldStr), ...split(newStr)]).join(', ');
  }

  extractOfficerId(text) {
    const m = /ID:\s*(\d+)/i.exec(String(text ?? ''));
    return m ? m[1].trim() : '';
  }

  extractCallsign(text) {
    const m = /\((\d+)\)|#(\d+)/.exec(String(text ?? ''));
    return m ? (m[1] ?? m[2]).trim() : '';
  }

  isAuthorPerformerMatch(tacGiaFull, tacGiaId, nguoiThucHien) {
    if (!nguoiThucHien) return true;
    const nthId = this.extractOfficerId(nguoiThucHien);
    if (tacGiaId && nthId) return tacGiaId === nthId;
    return S(tacGiaFull).toLowerCase() === S(nguoiThucHien).toLowerCase();
  }

  resolveViolatorMention(guild, nguoiThucHien) {
    if (!guild || !nguoiThucHien) return null;
    const cs = this.extractCallsign(nguoiThucHien);
    const nthId = this.extractOfficerId(nguoiThucHien);
    if (cs === EXEMPT_CS || nthId === EXEMPT_MOMO) return null;

    if (cs) {
      const m = guild.members.cache.find((mb) => callsignOf(mb.displayName) === cs);
      if (m) return m.toString();
    }
    if (nthId) {
      const re = new RegExp(`\\b${nthId}\\b`);
      const m = guild.members.cache.find((mb) => re.test(mb.displayName));
      if (m) return m.toString();
    }
    return null;
  }

  async sendUnauthorizedEditAlert({ incId, ts, nguoiThucHien, tacGiaFull, tieuDe = '' }) {
    try {
      const nthId = this.extractOfficerId(nguoiThucHien);
      const cs = this.extractCallsign(nguoiThucHien);
      if (cs === EXEMPT_CS || nthId === EXEMPT_MOMO) return;

      const key = `${incId}_${nthId || nguoiThucHien}_${ts}`;
      if (this.alertedKeys.has(key)) return;
      this.alertedKeys.add(key);
      if (this.alertedKeys.size > 500) this.alertedKeys.clear();

      const vpId = alertRoom('VP_SUA_MDT');
      const vp = this.bot.channels.cache.get(vpId);
      if (!vp) return console.error(`⚠️ Không tìm thấy phòng cảnh báo sửa MDT ID ${vpId}`);

      const guild = vp.guild;
      const violator = this.resolveViolatorMention(guild, nguoiThucHien);
      const pingParts = [roleMention(guild, 'Sở Trưởng Cảnh Sát'), roleMention(guild, 'Sở Phó Cảnh Sát')];
      if (violator) pingParts.push(violator);

      let performer = `**${nguoiThucHien}**`;
      if (violator) performer += ` (${violator})`;

      const embed = new EmbedBuilder()
        .setTitle('Sửa MDT không phải của mình')
        .setDescription('Người sửa không phải tác giả MDT.')
        .setColor(COLORS.red)
        .addFields(
          { name: 'Người sửa', value: performer, inline: false },
          { name: 'Tác giả', value: `**${tacGiaFull || 'Không rõ'}**`, inline: false },
          { name: 'MDT', value: `**#${incId}**` + (tieuDe ? ` (${tieuDe})` : ''), inline: true },
          { name: 'Thời gian', value: `\`${ts}\``, inline: true },
        )
        .setFooter({ text: 'Giám sát MDT tự động' });

      await vp.send({
        content: `🚨 **SỬA MDT TRÁI PHÉP** ${pingParts.join(' ')}`,
        embeds: [embed],
        allowedMentions: { parse: ['roles', 'users'] },
      });
    } catch (e) {
      console.error('❌ Lỗi gửi cảnh báo chỉnh sửa MDT trái phép:', e.message);
    }
  }

  // ==========================================
  // BÓC TÁCH EMBED MDT
  // ==========================================
  parseIncidentEmbed(embed, createdAt) {
    const desc = String(embed.description ?? '').replace(/[*_`]/g, '');

    const mId = /Incident ID:\s*#?(\d+)/i.exec(desc);
    if (!mId) return null;
    const incId = mId[1].trim();

    const tVn = toVN(createdAt);
    const ts = fmt(tVn, 'YYYY-MM-DD HH:mm:ss');

    const tieuDe = /Tiêu đề:\s*([^\n]+)/i.exec(desc)?.[1].trim() ?? '';
    const tacGiaFull = /Tác giả:\s*([^\n]+)/i.exec(desc)?.[1].trim() ?? '';
    const tacGiaId = this.extractOfficerId(tacGiaFull);
    const nguoiThucHien = /Người thực hiện:\s*([^\n]+)/i.exec(desc)?.[1].trim() ?? '';
    const nthId = this.extractOfficerId(nguoiThucHien);

    // Chốt chặn 1: Người thực hiện phải trùng Tác giả
    if (!this.isAuthorPerformerMatch(tacGiaFull, tacGiaId, nguoiThucHien)) {
      console.log(`🚫 [Chặn Ghi Đè] Incident #${incId}: Người thực hiện (${nguoiThucHien}) khác Tác giả (${tacGiaFull}).`);
      return { unauthorized: true, incId, ts, nguoiThucHien, tacGiaFull, tieuDe };
    }

    // Sĩ quan liên quan (nhiều khối nếu MDT nhiều tội phạm)
    const sqIds = [];
    for (const m of desc.matchAll(SQ_RE)) {
      const block = m[1].trim();
      if (block && block.toLowerCase() !== 'không có') {
        for (const x of block.matchAll(/ID:\s*(\d+)/gi)) sqIds.push(x[1]);
      }
    }

    // Cáo buộc
    const cbLines = [];
    for (const m of desc.matchAll(CB_RE)) {
      const block = m[1].trim();
      if (!block || block.toLowerCase() === 'không cáo buộc') continue;
      for (const line of block.split('\n')) {
        const l = line.trim().replace(/^[, ]+/, '');
        if (l && !l.startsWith('@') && l.toLowerCase() !== 'không cáo buộc') cbLines.push(l);
      }
    }

    // Tội phạm liên quan
    const tpNames = [];
    const tpIds = [];
    let inTp = false;
    for (const l of desc.split('\n')) {
      const lc = l.trim();
      if (lc.includes('Tội phạm liên quan')) {
        inTp = true;
        continue;
      }
      if (lc.includes('Dữ liệu liên quan')) break;
      if (inTp && lc.toLowerCase().includes('cid')) {
        const cl = lc.replace(/^\d+\.\s*|-\s*/g, '');
        const mn = /(.*?)\s*\(/.exec(cl);
        const name = mn ? mn[1].trim() : cl.split('(')[0].trim();
        if (name) tpNames.push(name);
        const mi = /ID\s*:\s*([a-zA-Z0-9_]+)/i.exec(cl);
        if (mi && mi[1].toLowerCase() !== 'offline') tpIds.push(mi[1].trim());
      }
    }

    const rowData = [
      ts, // A - Thời gian lập MDT
      incId, // B - Incident ID
      tieuDe, // C - Tiêu đề
      tacGiaFull, // D - Tác giả
      tacGiaId, // E - ID Tác giả
      uniq(sqIds).join(', '), // F - ID Sĩ quan liên quan
      nguoiThucHien, // G - Người thực hiện
      ts, // H - Thời gian chỉnh sửa
      uniq(cbLines).join(', '), // I - Cáo buộc
      uniq(tpNames).join(', '), // J - Tên tội phạm
      uniq(tpIds).join(', '), // K - ID tội phạm
    ];

    return { unauthorized: false, incId, tVn, ts, tacGiaFull, tacGiaId, tieuDe, nthId, nguoiThucHien, rowData };
  }

  // ==========================================
  // TRẠM XE BUÝT 10 GIÂY
  // ==========================================
  async batchProcessor() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 25);
    const ws = this.bot.sheets.incident;

    try {
      const allI = await ws.getAllValues();
      let rowCount = allI.length;
      const cellsMap = new Map();

      for (const item of batch) {
        const rowData = [...item.rowData];
        const nthId = item.nthId ?? '';
        let fIdx = -1;
        let skip = false;

        for (let idx = 0; idx < allI.length; idx++) {
          const row = allI[idx];
          if (row.length < 2 || S(row[1]) !== item.incId) continue;
          fIdx = idx + 1;

          // Đối chiếu chính chủ với Tác giả gốc trên Sheet (cột E)
          const oldTgId = row.length > 4 ? S(row[4]) : '';
          const oldTgFull = row.length > 3 ? S(row[3]) : '';
          if (oldTgId && nthId && oldTgId !== nthId) {
            if (item.isRealtime) {
              await this.sendUnauthorizedEditAlert({
                incId: item.incId,
                ts: item.ts,
                nguoiThucHien: item.nguoiThucHien,
                tacGiaFull: oldTgFull || item.tacGiaFull,
                tieuDe: item.tieuDe,
              });
            }
            skip = true;
            break;
          }

          // Quá 6 giờ kể từ lúc lập (cột A), hoặc bản sửa cũ hơn lúc lập -> không ghi đè
          const oldTime = parseYMDHMS(stripQuote(row[0]));
          const editTime = parseYMDHMS(stripQuote(rowData[7]));
          if (oldTime && editTime) {
            const diff = (editTime - oldTime) / 1000;
            if (diff > MAX_EDIT_SECONDS || diff < 0) {
              skip = true;
              break;
            }
          }

          // Không lấy bản cũ đè bản mới hơn (cột H)
          const oldUpd = row.length > 7 ? stripQuote(row[7]) : '';
          if (oldUpd) {
            const o = parseYMDHMS(oldUpd);
            if (o && editTime && editTime < o) {
              skip = true;
              break;
            }
          }

          rowData[0] = stripQuote(row[0]); // Giữ thời gian lập gốc
          if (oldTgId && !rowData[4]) rowData[4] = oldTgId;
          const oldSq = row.length > 5 ? S(row[5]) : '';
          if (oldSq) rowData[5] = this.mergeSqRelations(oldSq, rowData[5]);
          const oldTp = row.length > 10 ? S(row[10]) : '';
          if (oldTp) rowData[10] = this.mergeTpIds(oldTp, rowData[10]);
          break;
        }

        if (skip) continue;

        if (fIdx !== -1) {
          const existing = allI[fIdx - 1];
          for (let i = 1; i < rowData.length; i++) {
            const nv = sanitizeVal(rowData[i]);
            const ov = i < existing.length ? S(existing[i]) : '';
            if (S(nv).replace(/^'+/, '') !== ov.replace(/^'+/, '')) cellsMap.set(`${fIdx}:${i + 1}`, cell(fIdx, i + 1, nv));
          }
          while (existing.length < rowData.length) existing.push('');
          rowData.forEach((v, i) => (existing[i] = String(v)));
        } else {
          rowCount++;
          rowData.forEach((v, i) => cellsMap.set(`${rowCount}:${i + 1}`, cell(rowCount, i + 1, sanitizeVal(v))));
          allI.push(rowData.map(String));
        }
      }

      if (cellsMap.size) {
        // Tự cơi nới thêm hàng nếu tràn giới hạn Sheet
        const maxRow = Math.max(...[...cellsMap.values()].map((c) => c.row));
        if (maxRow > ws.rowCount) {
          const add = Math.max(200, maxRow - ws.rowCount + 50);
          await ws.addRows(add);
          console.log(`📈 [Auto Expand] Đã tự động cơi nới thêm ${add} hàng mới vào Sheet Incident!`);
        }
        await ws.updateCells([...cellsMap.values()]);
        console.log(`🚀 [Bus Station] Đã đồng bộ thành công cụm Incident (${cellsMap.size} ô cập nhật)!`);
      }
    } catch (e) {
      console.error(`⚠️ Lỗi chuyến xe buýt Incident (Đang hoàn trả ${batch.length} MDT vào hàng đợi để thử lại):`, e.message);
      this.queue.push(...batch);
      await this.sleep(5000);
    }
  }

  async onMessage(message) {
    if (this.isSelf(message)) return;
    if (message.channel.id !== ROOMS.INCIDENT || !message.embeds.length) return;
    try {
      for (const embed of message.embeds) {
        const parsed = this.parseIncidentEmbed(embed, message.createdAt);
        if (!parsed) continue;
        if (parsed.unauthorized) {
          await this.sendUnauthorizedEditAlert(parsed);
          continue;
        }
        parsed.isRealtime = true;
        this.queue.push(parsed);
        console.log(`📥 Đã đưa Incident #${parsed.incId} vào Hàng Đợi (Queue).`);
      }
    } catch (e) {
      console.error('❌ Lỗi quét tin nhắn MDT Incident:', e.message);
    }
  }

  // ==========================================
  // QUÉT LỊCH SỬ (CŨ -> MỚI), GỘP CÁC BẢN SỬA HỢP LỆ
  // ==========================================
  async collectValidIncidents(channel, after, before) {
    const dict = new Map();
    for await (const message of history(channel, { limit: null, after, before, oldestFirst: true })) {
      if (message.content.startsWith('!') || !message.embeds.length) continue;
      for (const embed of message.embeds) {
        const pkg = this.parseIncidentEmbed(embed, message.createdAt);
        if (!pkg || pkg.unauthorized) continue;

        const existing = dict.get(pkg.incId);
        if (!existing) {
          pkg.createTimeVn = pkg.tVn;
          dict.set(pkg.incId, pkg);
          continue;
        }

        const origTgId = existing.rowData[4];
        if (origTgId && pkg.nthId && origTgId !== pkg.nthId) continue;

        const diff = (pkg.tVn - existing.createTimeVn) / 1000;
        if (diff >= 0 && diff <= MAX_EDIT_SECONDS) {
          pkg.rowData[0] = existing.rowData[0];
          pkg.createTimeVn = existing.createTimeVn;
          if (origTgId && !pkg.rowData[4]) pkg.rowData[4] = origTgId;
          if (existing.rowData[5]) pkg.rowData[5] = this.mergeSqRelations(existing.rowData[5], pkg.rowData[5]);
          if (existing.rowData[10]) pkg.rowData[10] = this.mergeTpIds(existing.rowData[10], pkg.rowData[10]);
          dict.set(pkg.incId, pkg);
        }
      }
    }
    return dict;
  }

  // !updateincident [dd/mm/yyyy] [dd/mm/yyyy]
  async updateIncident(ctx, fromStr, toStr) {
    if (!isBotAdmin(ctx.author)) return ctx.send(NO_PERM);

    const now = nowVN();
    let from, to;
    if (!fromStr) {
      from = addMs(now, -24 * HOUR_MS);
      to = now;
      await ctx.send('⏳ Đang quét bù Incident 24h qua...\nℹ️ Quét theo ngày: `!updateincident 01/07/2026 15/07/2026`');
    } else {
      from = parseDMY(fromStr);
      const toDay = toStr ? parseDMY(toStr) : now;
      if (!from || !toDay) {
        return ctx.send('⚠️ Cú pháp: `!updateincident [dd/mm/yyyy] [dd/mm/yyyy]`\nVí dụ: `!updateincident 01/07/2026 15/07/2026`');
      }
      to = endOfDay(toDay);
      await ctx.send(`⏳ Đang quét bù Incident từ **${fmt(from, 'DD/MM/YYYY')}** đến **${fmt(to, 'DD/MM/YYYY')}**...`);
    }

    try {
      const channel = this.bot.channels.cache.get(ROOMS.INCIDENT);
      if (!channel) return ctx.send('❌ Không tìm thấy kênh log Incident.');

      const dict = await this.collectValidIncidents(channel, vnToUtc(from), vnToUtc(to));
      if (!dict.size) return ctx.send('📭 Không có Incident hợp lệ trong khoảng này.');

      this.queue.push(...dict.values());
      await ctx.send(`✅ Đã đưa **${dict.size}** Incident vào hàng đợi ghi sheet.`);
    } catch (e) {
      await ctx.send(`❌ Lỗi: ${e.message}`);
    }
  }

  // Mỗi giờ: rà soát 12h qua, nạp bù MDT bị sót hoặc có bản sửa mới
  async autoScan() {
    console.log('⏳ [Auto Scan] Bắt đầu rà soát MDT Incident bị sót trong 12h qua...');
    try {
      const channel = this.bot.channels.cache.get(ROOMS.INCIDENT);
      if (!channel) return;

      const now = nowVN();
      const dict = await this.collectValidIncidents(channel, vnToUtc(addMs(now, -12 * HOUR_MS)), vnToUtc(now));
      if (!dict.size) return;

      const allI = await this.bot.sheets.incident.getAllValues();
      const sheetMap = new Map();
      for (const row of allI) {
        if (row.length < 2) continue;
        const id = S(row[1]);
        if (id) sheetMap.set(id, row.length > 7 ? stripQuote(row[7]) : '');
      }

      let missed = 0;
      for (const [id, pkg] of dict) {
        const upd = stripQuote(pkg.rowData[7]);
        if (!sheetMap.has(id) || sheetMap.get(id) !== upd) {
          this.queue.push(pkg);
          missed++;
        }
      }

      if (missed) console.log(`✅ [Auto Scan] Đã phát hiện và nạp bù ${missed} biên bản Incident vào hàng đợi!`);
      else console.log('📭 [Auto Scan] Hoàn tất rà soát. Không có MDT nào bị sót!');
    } catch (e) {
      console.error('❌ [Auto Scan] Lỗi khi tự động rà soát:', e.message);
    }
  }
}
