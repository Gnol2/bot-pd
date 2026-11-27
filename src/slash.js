// Mô tả slash command (/lệnh) cho từng lệnh trong this.commands của các module.
// args: gợi ý tham số (hiện trong ô "tham_so" khi gõ lệnh). null = lệnh không có tham số.
// required: bắt buộc nhập tham số.
// Lệnh nào không có ở đây vẫn được đăng ký, với mô tả mặc định và tham số tuỳ chọn.
const DATE_RANGE = '[dd/mm/yyyy] [dd/mm/yyyy] (bỏ trống = 24h qua)';

export const SLASH_META = {
  // Quản trị module (index.js)
  load: { desc: 'Bật module', args: '<tên module>', required: true },
  unload: { desc: 'Tắt module', args: '<tên module>', required: true },
  reload: { desc: 'Tải lại module', args: '<tên module>', required: true },

  // sync_gcpd
  updategcpdhome: { desc: 'Đồng bộ GCPD HOME → Danh-Sach-PD + Online', args: null },

  // hoadon / hoadonbv / log_incident / log_nhansu / dispatch
  updatehoadon: { desc: 'Quét bù hóa đơn', args: DATE_RANGE },
  updatehoadonbv: { desc: 'Quét bù hóa đơn BV', args: DATE_RANGE },
  updateincident: { desc: 'Quét bù Incident', args: DATE_RANGE },
  updateduty: { desc: 'Quét bù log Duty', args: DATE_RANGE },
  updateradio: { desc: 'Quét bù log Radio', args: DATE_RANGE },
  updatedispatch: { desc: 'Đồng bộ Dispatch lên Sheets', args: DATE_RANGE },
  dispatch: { desc: 'Thống kê Dispatch', args: DATE_RANGE },
  dispatchlist: { desc: 'Quét các log Dispatch gần nhất', args: '[số lượng]' },

  // gplmb
  vipham: { desc: 'Đóng dấu vi phạm GPLMB', args: '<momo>', required: true },
  yes: { desc: 'Xác nhận đã thu GPLMB', args: '<momo>', required: true },
  no: { desc: 'Xác nhận chưa thu được GPLMB', args: '<momo>', required: true },
  kiemtra: { desc: 'Kiểm tra GPLMB', args: '<momo>', required: true },

  // luat
  luat: { desc: 'Tra cứu luật GCPD', args: '[mã | từ khóa] (bỏ trống = danh sách)' },

  // log_hoadon_113
  quetdulieu: { desc: 'Quét lịch sử hóa đơn vào sheet', args: '[momo] DD/MM/YYYY-DD/MM/YYYY', required: true },
  hoadon: { desc: 'Tính hóa đơn / thưởng 113', args: '[DD/MM-DD/MM] (bỏ trống = tuần này)' },

  // cham_cong
  chamcong: { desc: 'Danh sách đang ON DUTY', args: null },
  list: { desc: 'Danh sách đang ON DUTY', args: null },
  leave: { desc: 'Xoá PD khỏi danh sách ON (không ghi giờ)', args: '<momo|callsign> [...]', required: true },
  helpchamcong: { desc: 'Hướng dẫn chấm công', args: null },
  updatechamcong: { desc: 'Dựng lại giờ trực cả tuần từ kênh Duty', args: '[dd/mm/yyyy] (bỏ trống = tuần này)' },

  // dangky_ca
  dangky: { desc: 'Đăng ký ca trực', args: '<ca> [ca 2] [ngày] — vd: 8 · 14-16 20-22 mai · 3 18/11', required: true },
  huyca: { desc: 'Hủy ca trực', args: '<ca> [ngày] — vd: 8 · 14-16 mai', required: true },
  lichtruc: { desc: 'Xem lịch ca trực trong ngày', args: '[ngày] — vd: mai · 18/11' },
  cacuatoi: { desc: 'Xem ca mình đã đăng ký 7 ngày tới', args: null },
  xoaca: { desc: 'Xóa ca của PD khác (quản lý)', args: '<callsign|momo> <ca> [ngày] — vd: 609 8 mai', required: true },
  help: { desc: 'Danh sách tất cả lệnh của bot', args: null },
  helpca: { desc: 'Hướng dẫn đăng ký ca', args: null },

  // log_handcuff
  congtay: { desc: 'Thống kê còng tay', args: '<ID> <DD/MM-DD/MM> — vd: 12345 01/11-07/11', required: true },

  // check_dam
  updatechucvu: { desc: 'Đồng bộ chức vụ từ GCPD HOME', args: null },
  top113: { desc: 'Bảng xếp hạng 113', args: null },
  top113tuan: { desc: 'Bảng xếp hạng 113 tuần', args: null },
  radio: { desc: 'Kiểm tra kênh đàm', args: null },
  add113: { desc: 'Cộng phút 113', args: '<callsign|momo> <phút>', required: true },
  sub113: { desc: 'Trừ phút 113', args: '<callsign|momo> <phút>', required: true },

  // role
  updaterole: { desc: 'Quét bù thay đổi chức vụ', args: '[số lượng]' },

  // kpi
  top: { desc: 'Bảng xếp hạng KPI tuần', args: '[tuần] — vd: 31/8-6/9' },
  kpi: { desc: 'Xem KPI', args: '[momo] [tuần] — vd: 12345 31/8-6/9' },
  lamviec: { desc: 'Ping Sĩ quan 0 KPI tuần này', args: null },

  // ungtuyen
  ungtuyenpanel: { desc: 'Đặt bảng nút "Nộp đơn" ứng tuyển PD vào kênh này (PD bot admin)', args: null },
  nhanday: { desc: 'Nhận dạy học viên (gõ trong kênh đơn ứng tuyển)', args: null, ephemeral: true }, // trả lời chỉ người gõ thấy
  bangiao: { desc: 'Dạy xong, bàn giao CSV mới cho Sở (chỉ dùng trong kênh BANGIAO)', args: '[momo] [mã đơn] — bỏ trống = momo đã lưu lúc /nhanday' },
  nhanbangiao: { desc: 'Sở nhận bàn giao CSV mới (chỉ dùng trong kênh BANGIAO)', args: '[momo] — bỏ trống nếu chỉ có 1 bàn giao đang chờ' },
  dsbangiao: { desc: 'Danh sách đang dạy / chờ Sở nhận / đã nhận bàn giao', args: null },
};

export const ARG_OPTION = 'tham_so';

// Tên nhóm hiển thị trong /help (theo tên file module). Module không có ở đây hiện bằng tên file.
export const COG_LABELS = {
  dangky_ca: '🗓️ Đăng ký ca trực',
  cham_cong: '⏱️ Chấm công',
  gplmb: '🪪 GPLMB',
  kpi: '📊 KPI',
  log_hoadon_113: '🧾 Hóa đơn 113',
  check_dam: '📻 Đàm / 113',
  dispatch: '📡 Dispatch',
  luat: '📚 Luật',
  ungtuyen: '📝 Ứng tuyển PD',
  log_handcuff: '🔗 Còng tay',
  hoadon: '🧾 Quét bù dữ liệu',
  hoadonbv: '🧾 Quét bù dữ liệu',
  log_incident: '🧾 Quét bù dữ liệu',
  log_nhansu: '🧾 Quét bù dữ liệu',
  role: '🧾 Quét bù dữ liệu',
  sync_gcpd: '🧾 Quét bù dữ liệu',
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Dựng JSON đăng ký slash command từ danh sách tên lệnh
export function buildSlashDefs(names) {
  return [...new Set(names)]
    .filter((n) => /^[a-z0-9_-]{1,32}$/.test(n))
    .sort()
    .map((name) => {
      const meta = SLASH_META[name] ?? { desc: `Lệnh ${name}`, args: '[tham số]' };
      const def = { name, description: clip(meta.desc, 100), dm_permission: false };
      if (meta.args !== null) {
        def.options = [
          { type: 3 /* STRING */, name: ARG_OPTION, description: clip(meta.args, 100), required: !!meta.required },
        ];
      }
      return def;
    });
}
