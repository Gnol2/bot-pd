// Kiểm tra nhanh: import + khởi tạo mọi module với bot giả (không kết nối Discord / Google)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cogDir = path.join(root, 'src', 'cogs');

const fakeBot = { readyPromise: new Promise(() => {}), user: { id: '0' }, channels: { cache: new Map() } };
let failed = 0;

for (const file of fs.readdirSync(cogDir).filter((f) => f.endsWith('.js'))) {
  try {
    const mod = await import(pathToFileURL(path.join(cogDir, file)).href);
    const cog = new mod.default(fakeBot);
    const cmds = Object.keys(cog.commands);
    console.log(`✅ ${file.padEnd(24)} lệnh: ${cmds.length ? cmds.map((c) => '!' + c).join(', ') : '(không có)'}${cog.onMessage ? ' | có listener' : ''}`);
    cog.unload();
  } catch (e) {
    failed++;
    console.error(`❌ ${file}:`, e);
  }
}

// Kiểm tra vài hàm tiện ích
const u = await import(pathToFileURL(path.join(root, 'src', 'utils.js')).href);
const assert = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error('❌ utils:', msg);
  }
};
assert(u.fmt(u.parseYMDHMS('2026-11-08 09:05:03'), 'DD/MM/YYYY HH:mm:ss') === '08/11/2026 09:05:03', 'parse/fmt');
assert(u.parseYMDHMS('2026-02-30 00:00:00') === null, 'ngày không hợp lệ');
assert(u.weekday(u.parseDMY('09/11/2026')) === 0, 'thứ Hai = 0');
assert(u.weekSheetName(u.parseDMY('09/11/2026')) === '9/11-15/11', 'tên sheet tuần');
assert(u.cleanRadio('113.0') === '113' && u.cleanRadio('1.5') === '1.5' && u.cleanRadio('abc') === 'abc', 'cleanRadio');
assert(u.money(1234567) === '1,234,567', 'money');
assert(u.fmtG(14) === '14' && u.fmtG(2.5) === '2.5', 'fmtG');
assert(u.sanitizeVal(' 123 ') === 123 && u.sanitizeVal('12a') === '12a' && u.sanitizeVal(5) === 5, 'sanitizeVal');
const fakeMsg = {
  createdAt: new Date(Date.UTC(2026, 10, 8, 2, 0, 0)),
  embeds: [{ fields: [
    { name: 'Tiêu đề', value: 'Phạt VPGT' },
    { name: 'Người gửi', value: '[123] Nguyen A' },
    { name: 'Người nhận', value: '[456] Tran B' },
    { name: 'Số tiền', value: '$7,350' },
    { name: 'Trạng thái', value: '🟡 Chưa thanh toán' },
  ] }],
};
assert(
  JSON.stringify(u.processEmbedMessage(fakeMsg)) ===
    JSON.stringify(["'2026-11-08 09:00:00", 'Phạt VPGT', '123', 'Nguyen A', '456', 'Tran B', '7350', 'Chưa thanh toán']),
  'processEmbedMessage',
);

console.log(failed ? `\n❌ Có ${failed} lỗi` : '\n✅ Tất cả module load OK');
process.exit(failed ? 1 : 0);
