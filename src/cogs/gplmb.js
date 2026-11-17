import { Cog } from '../core/Cog.js';
import { ROOMS } from '../config.js';
import { S, at, cell, isDigits, fmt, toVN, hasRole, roleByName, layIdTheoCallsign, Mutex } from '../utils.js';

const ROLE_AS = 'Air Squadron 51th';

// Lọc thông minh: bỏ ô trống, !yes, !no -> còn lại là log vi phạm
const viphamLogs = (row) =>
  row.slice(12).map(String).filter((x) => x.trim() !== '' && !x.includes('!yes') && !x.includes('!no'));

function parseLogOfficer(log, guild) {
  const tm = /(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/.exec(log);
  let namePart;
  let time = null;
  if (tm) {
    time = tm[1];
    namePart = log.split(time)[0].replace(/^[ |']+|[ |']+$/g, '');
  } else {
    namePart = log.split('|')[0].trim();
  }
  const cs = namePart.split('|')[0].trim();
  const uid = layIdTheoCallsign(guild, cs);
  return { str: uid ? `<@${uid}>` : `**${namePart}**`, time };
}

// Quản lý GPLMB: !vipham, !yes, !no, !kiemtra (đủ 5 lần vi phạm -> tịch thu)
export default class GPLMB extends Cog {
  constructor(bot) {
    super(bot);
    this.pendingRevokes = new Map();
    this.writeLock = new Mutex();
    this.cache = [];
    this.cacheTime = 0;
    this.commands = {
      vipham: (ctx, momo) => this.vipham(ctx, momo),
      yes: (ctx, momo) => this.yesNo(ctx, momo, 'yes'),
      no: (ctx, momo) => this.yesNo(ctx, momo, 'no'),
      kiemtra: (ctx, momo) => this.kiemtra(ctx, momo),
    };
  }

  async fetchData() {
    if (!this.cache.length || Date.now() - this.cacheTime > 60_000) {
      this.cache = await this.bot.sheets.giayTo.getAllValues();
      this.cacheTime = Date.now();
    }
    return this.cache;
  }

  async updateCellsAndCache(cells) {
    for (const c of cells) {
      while (this.cache.length < c.row) this.cache.push([]);
      const r = this.cache[c.row - 1];
      while (r.length < c.col) r.push('');
      r[c.col - 1] = String(c.value);
    }
    await this.bot.sheets.giayTo.updateCells(cells);
  }

  getViphamOfficersSince5(row, guild) {
    if (!row || !row.length) return 'Không rõ';
    const logs = viphamLogs(row);
    const officers = [];
    if (logs.length >= 5) {
      for (const log of logs.slice(4)) {
        const { str } = parseLogOfficer(log, guild);
        if (!officers.includes(str)) officers.push(str);
      }
    }
    return officers.length ? officers.join(' ') : 'Không rõ';
  }

  async remindTichThu(momo, channel) {
    while (this.pendingRevokes.has(momo)) {
      await this.sleep(60_000);
      if (this._stopped) return;
      const data = this.pendingRevokes.get(momo);
      if (!data) return;

      const pings = [`<@${data.author}>`];
      if (data.last_no) pings.push(`<@${data.last_no}>`);
      if (data.old_officers && data.old_officers !== 'Không rõ') pings.push(data.old_officers);
      const pingStr = pings.join(' ');

      let msg;
      if (data.old_officers) {
        msg = `🚨 **NHẮC TỊCH THU GPLMB**\n${pingStr}\nMomo **${momo}** đang dùng bằng đã/phải tịch thu. <@${data.author}> xác nhận \`!yes ${momo}\` sau khi thu bù.`;
      } else if (data.last_no) {
        msg = `🚨 **NHẮC TỊCH THU GPLMB**\n${pingStr}\nĐã quá 1 phút, cần thu GPLMB của Momo **${momo}** ngay.`;
      } else {
        msg = `🚨 **NHẮC TỊCH THU GPLMB**\n${pingStr}\nĐã quá 1 phút, chưa có xác nhận \`!yes ${momo}\` / \`!no ${momo}\` cho Momo **${momo}**.`;
      }
      await channel.send(msg).catch((e) => console.error('Lỗi nhắc tịch thu:', e.message));
    }
  }

  startReminder(momo, info, channel) {
    if (this.pendingRevokes.has(momo)) return;
    this.pendingRevokes.set(momo, info);
    this.remindTichThu(momo, channel);
  }

  async checkPermissions(ctx, cmd) {
    if (hasRole(ctx.author, ROLE_AS)) return true;
    const role = roleByName(ctx.guild, ROLE_AS);
    const mention = role ? role.toString() : `@&${ROLE_AS}`;
    if (cmd === 'vipham') {
      await ctx.reply(`❌ Cần role **${ROLE_AS}**.\nℹ️ ${mention} vui lòng xử lý vi phạm này.`);
    } else {
      await ctx.reply(`❌ Cần role **${ROLE_AS}**.`);
    }
    return false;
  }

  async getActiveRow(momo) {
    const all = await this.fetchData();
    let activeIdx = -1;
    let activeData = [];
    let revokedCount = 0;
    let lastRevoked = [];
    const allActive = [];

    for (let i = 1; i < all.length; i++) {
      const row = all[i];
      const loai = S(at(row, 0));
      if (!loai.includes('Property Deed') && !loai.includes('GPLMB')) continue;
      const rowMomo = S(at(row, 5));
      const tichThu = row.length > 9 ? S(row[9]) : '0';
      if (rowMomo !== momo) continue;
      if (tichThu === '0' || tichThu === '') {
        activeIdx = i + 1;
        activeData = row;
        allActive.push([i + 1, row]);
      } else if (tichThu === '1') {
        revokedCount++;
        lastRevoked = row;
      }
    }
    return { activeIdx, activeData, revokedCount, lastRevoked, allActive };
  }

  nextLogCol(row) {
    let col = 13;
    while (col - 1 < row.length && String(row[col - 1]).trim() !== '') col++;
    return col;
  }

  // ==========================================
  // !vipham <momo>
  // ==========================================
  async vipham(ctx, momo) {
    if (ctx.channel.id !== ROOMS.GPLMB_CMD) return;
    if (!(await this.checkPermissions(ctx, 'vipham'))) return;
    if (!momo) return ctx.reply('⚠️ Cú pháp: `!vipham <momo>`');

    const tsRaw = fmt(toVN(ctx.message.createdAt), 'YYYY-MM-DD HH:mm:ss');
    const logMsg = `${ctx.author.displayName} | ${tsRaw} | !vipham`;

    try {
      await this.writeLock.run(async () => {
        const { activeIdx, activeData, revokedCount, lastRevoked } = await this.getActiveRow(momo);

        // Không có bằng đang hoạt động
        if (activeIdx === -1) {
          if (revokedCount > 0) {
            const officers = this.getViphamOfficersSince5(lastRevoked, ctx.guild);
            await ctx.reply(
              `🚨 **GPLMB ĐÃ BỊ TỊCH THU**\n` +
                `Momo: **${momo}**\n` +
                `Đóng dấu từ lần 5 (bằng cũ): ${officers}\n` +
                `<@${ctx.author.id}>: phạt tội **Không có GPLMB** và thu tờ GPLMB không hợp lệ (nếu có).`,
            );
          } else {
            await ctx.reply(`❌ Momo **${momo}** chưa từng đăng ký GPLMB. Phạt tội **Không có GPLMB**.`);
          }
          return;
        }

        let curV = isDigits(at(activeData, 8)) ? parseInt(activeData[8], 10) : 0;

        // Đã đủ 5 lần mà chưa bị tịch thu
        if (curV >= 5) {
          const logs = viphamLogs(activeData);
          const log5 = logs.length >= 5 ? logs[4] : logs.length ? logs[logs.length - 1] : '';
          let officer5 = 'Không rõ';
          let time5 = 'Không rõ';
          if (log5) {
            const r = parseLogOfficer(log5, ctx.guild);
            officer5 = r.str;
            if (r.time) time5 = r.time;
          }

          await ctx.reply(
            `🚨 **GPLMB ĐỦ ${curV} LẦN CHƯA TỊCH THU**\n` +
              `Momo: **${momo}**\n` +
              `Đóng dấu lần 5: ${officer5} lúc \`${time5}\` (chưa thu bằng)\n` +
              `<@${ctx.author.id}>: thu bù rồi xác nhận \`!yes ${momo}\` / \`!no ${momo}\`, phạt tội **Không có GPLMB**.`,
          );
          this.startReminder(
            momo,
            { author: ctx.author.id, last_no: null, old_officers: officer5 !== 'Không rõ' ? officer5 : null },
            ctx.channel,
          );
          return;
        }

        curV += 1;
        const nextCol = this.nextLogCol(activeData);
        await this.updateCellsAndCache([cell(activeIdx, 9, curV), cell(activeIdx, nextCol, logMsg)]);

        if (curV >= 5) {
          await ctx.reply(`🚨 **VI PHẠM LẦN ${curV}: TỊCH THU GPLMB**\nMomo: **${momo}**\nĐã thu chưa? \`!yes ${momo}\` / \`!no ${momo}\``);
          const lastNo = activeData.length > 11 ? S(activeData[11]) || null : null;
          this.startReminder(momo, { author: ctx.author.id, last_no: lastNo, old_officers: null }, ctx.channel);
        } else {
          await ctx.reply(`✅ Đã đóng dấu vi phạm Momo **${momo}**: **${curV}**/5 lần.`);
        }
      });
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // !yes <momo> / !no <momo>
  // ==========================================
  async yesNo(ctx, momo, kind) {
    if (ctx.channel.id !== ROOMS.GPLMB_CMD) return;
    if (!(await this.checkPermissions(ctx, kind))) return;
    if (!momo) return ctx.reply(`⚠️ Cú pháp: \`!${kind} <momo>\``);

    const logMsg = `${ctx.author.displayName} | ${fmt(toVN(ctx.message.createdAt), 'YYYY-MM-DD HH:mm:ss')} | !${kind}`;
    try {
      await this.writeLock.run(async () => {
        const { activeIdx, activeData } = await this.getActiveRow(momo);
        if (activeIdx === -1) return ctx.reply(`❌ Không tìm thấy GPLMB đang hoạt động của Momo **${momo}**.`);

        const nextCol = this.nextLogCol(activeData);
        if (kind === 'yes') {
          await this.updateCellsAndCache([cell(activeIdx, 10, 1), cell(activeIdx, 11, 0), cell(activeIdx, nextCol, logMsg)]);
          this.pendingRevokes.delete(momo); // Tắt chuông báo động
          await ctx.reply(`✅ Đã ghi nhận tịch thu GPLMB của Momo **${momo}**.`);
        } else {
          await this.updateCellsAndCache([
            cell(activeIdx, 11, 1),
            cell(activeIdx, 12, String(ctx.author.id)),
            cell(activeIdx, nextCol, logMsg),
          ]);
          this.pendingRevokes.delete(momo);
          await ctx.reply(`⚠️ Đã ghi nhận chưa tịch thu GPLMB của Momo **${momo}**.`);
        }
      });
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }

  // ==========================================
  // !kiemtra <momo>
  // ==========================================
  async kiemtra(ctx, momo) {
    if (ctx.channel.id !== ROOMS.GPLMB_CMD) return;
    if (!momo) return ctx.reply('⚠️ Cú pháp: `!kiemtra <momo>`');

    try {
      const { activeIdx, activeData, revokedCount, allActive } = await this.getActiveRow(momo);
      const info = (r) => ({
        ngayCap: r.length > 1 ? S(r[1]) : 'Không rõ',
        sqCap: r.length > 3 ? S(r[3]) : 'Không rõ',
        chuSoHuu: r.length > 4 ? S(r[4]) : 'Không rõ',
        curV: isDigits(at(r, 8)) ? parseInt(r[8], 10) : 0,
        redAlert: r.length > 10 && S(r[10]) === '1',
      });

      if (activeIdx !== -1) {
        if (allActive.length === 1) {
          const i = info(activeData);
          let rep =
            `ℹ️ GPLMB Momo **${momo}**\n` +
            `Trạng thái: 🟢 Đang hoạt động\n` +
            `Chủ sở hữu: **${i.chuSoHuu}**\n` +
            `Người cấp: **${i.sqCap}**\n` +
            `Ngày cấp: **${i.ngayCap}**\n` +
            `Vi phạm: **${i.curV}** lần\n` +
            `Tiền án: **${revokedCount}** lần`;
          if (i.redAlert) rep += '\n🚨 Cần tịch thu GPLMB ngay.';
          return ctx.reply(rep);
        }

        let rep =
          `ℹ️ GPLMB Momo **${momo}**\n` +
          `Trạng thái: 🟢 Đang hoạt động (**${allActive.length}** GPLMB)\n` +
          `Tiền án: **${revokedCount}** lần\n\n`;
        let red = false;
        allActive.forEach(([, row], n) => {
          const i = info(row);
          rep += `**GPLMB ${n + 1}**\n`;
          rep += ` ├ Chủ sở hữu: **${i.chuSoHuu}**\n`;
          rep += ` ├ Người cấp: **${i.sqCap}**\n`;
          rep += ` ├ Ngày cấp: **${i.ngayCap}**\n`;
          rep += ` └ Vi phạm: **${i.curV}** lần\n\n`;
          if (i.redAlert) red = true;
        });
        if (red) rep += '🚨 Cần tịch thu GPLMB ngay.';
        return ctx.reply(rep.trim().slice(0, 2000));
      }

      if (revokedCount > 0) {
        return ctx.reply(
          `ℹ️ GPLMB Momo **${momo}**\n` +
            `Trạng thái: 🔴 Đã tịch thu\n` +
            `Tiền án: **${revokedCount}** lần\n` +
            `Nếu đối tượng còn GPLMB trong người: thu bằng và phạt tội **Không có GPLMB**.`,
        );
      }
      await ctx.reply(`❌ Momo **${momo}** chưa từng đăng ký GPLMB.`);
    } catch (e) {
      await ctx.reply(`❌ Lỗi: ${e.message}`);
    }
  }
}
