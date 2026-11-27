// Lệnh dùng dạng slash command (/lệnh) — mô tả từng lệnh ở src/slash.js

// Role được dùng toàn bộ lệnh quản lý của bot (đổi tên role trên Discord thì sửa ở đây)
export const BOT_ADMIN_ROLE = 'PD bot admin';

// ==========================================
// GOOGLE SPREADSHEET IDs
// ==========================================
export const SHEET_IDS = {
  MAIN: '1e_TIX1_MSlVKtt1TIV3GEhUY4juOpGPe6Wwptpkt-yY', // File chính "GCPD DATA" (Online, Hoa-Don, Incident, tab KPI tuần...)
  HOME: '1WiN4rD5YEyQLHyCbShYnvvSPHqRI0K6drdlcbhZjB9U', // GCPD HOME, Dispatch
  PHONGVAN: '18sRWnDVttvBC26iKukbwgBgoEEQLCh4GhAavIIz0DDI', // Form tuyển dụng
  LUONG: '1BaGq__14HqVT8VcSsP2ZGH0kmuQEsIm4TKkNiQCjDHc', // File Lương GCPD: tab tuần "d/m-d/m", bot ghi giờ ON-OFF vào cột E..K
  LUAT: '1uLpKViLYlzhyBDO7lzoNydiWr77WO3WAkRBypFbVP0I', // "Tội phạm phải đọc" (tab luatpd + tricklobicam) — /ai tra cứu từ file này
};

// ==========================================
// DISCORD ROOM IDs (snowflake luôn để dạng chuỗi)
// ==========================================
export const ROOMS = {
  HOA_DON: '1414149636704305162',
  HOA_DON_BV: '1453116362468622538',
  TRA_LOI: '1571029495689777213',
  KPI: '1575491436281987102',
  INCIDENT: '1414548826118684752',
  TAM_GIAM: '1446691326828740718',
  GIAY_TO: '1466646649563517221',
  GPLMB_CMD: '1575491908799696937',
  DOI_BAY: '1575494258872295444',
  DUTY: '1452729913172955287',
  RADIO: '1486234519416864910',
  ROLE: '1516858802081759415',
  CHECK_DAM: '1575491317256163378',
  TOP_113: '1575492381686632459',
  VI_PHAM: '1575495177861074944',
  HANDCUFF: '1471744834581827708',
  CLOCKOUT: '1414548963247390770',
  DISPATCH: '1518939026391040050',
  BANGIAO: '1373960361832878150',

  DIEM_DANH: '1459604562947346736', // Log chấm công: mỗi lần ghi giờ OFF DUTY vào sheet Lương. Để trống '' = tắt
  DANG_KY_CA: '1575566198559613077', // Kênh dùng lệnh đăng ký ca trực (/dangky, /huyca, /lichtruc...). Để trống '' = dùng ở mọi kênh
  AI: '1572130947216838756', // Kênh trợ lý luật: /ai hoặc @tag bot (module ai)

  // Momo lạ OnDuty, người ngoài dùng còng, còng khi OFF DUTY, sửa MDT trái phép: gửi chung vào VI_PHAM,
  // mỗi loại 1 màu (xem src/violation.js)
  VP_DAM: '1575493093736710154', // Danh sách vi phạm đàm cuối ngày (check_dam)
};

// Cấp được gọi điều đàm khi đàm 113 trống / quá tải (check_dam), xếp từ CAO xuống THẤP.
// Giá trị khớp đúng cột E (chức vụ) của sheet Online. Bot ping TẤT CẢ người onduty thuộc các cấp này,
// thứ tự tag theo thứ tự cấp bên dưới. Ngang cấp thì để chung một mảng, vd: ['GD', 'PGD'].
export const DIEU_DAM_RANKS = [['GD'], ['S-PGD'], ['PGD'], ['ST', 'GSDPUN', 'GSDB'], ['SP', 'TKDPUN', 'PGSDB'], ['DTDPUN']];

// ==========================================
// ỨNG TUYỂN PD (module ungtuyen): nút "Nộp đơn" -> form -> kênh ticket riêng
// ==========================================
export const UNG_TUYEN = {
  CATEGORY: '', // ID danh mục (category) chứa kênh ticket. Để trống '' = cùng danh mục với kênh đặt nút
  // Các role dưới đây + PD bot admin đều xem và nhắn tin được trong kênh đơn
  FTO_ROLES: ['FTO'], // Nhận dạy (/nhanday); đóng ticket khi chưa ai nhận dạy hoặc đã bàn giao
  SO_ROLES: ['Sở Trưởng Cảnh Sát', 'Sở Phó Cảnh Sát'], // Được tag khi /bangiao và trong thông báo kênh BANGIAO lúc đóng ticket
  TEACH_TAB: 'Nhan-Day', // Tab lưu nhận dạy trong file tuyển dụng (SHEET_IDS.PHONGVAN), tự tạo nếu chưa có
  CSV_RANKS: ['CSV'], // /bangiao <momo> chỉ chạy khi momo có chức vụ này (cột E GCPD HOME)
  REMIND_MIN: 30, // Nhắc Sở trong kênh BANGIAO mỗi N phút nếu chưa ai /nhanbangiao
};

// Lấy ID kênh cảnh báo: dùng kênh riêng nếu đã điền, không thì rơi về VI_PHAM
export const alertRoom = (key) => ROOMS[key] || ROOMS.VI_PHAM;

export const FIREBASE_URL =
  'https://dispatch-gcpd-default-rtdb.asia-southeast1.firebasedatabase.app/new_dispatch.json';

// Các module tự load khi khởi động (giống cogs_list trong main.py).
// hoadonbv có file nhưng không có trong danh sách gốc -> bật bằng lệnh `/load hoadonbv`.
export const COGS = [
  'kpi',
  'gplmb',
  'log_giayto',
  'log_tamgiam',
  'log_incident',
  'hoadon',
  'log_hoadon_113',
  'checker_blht',
  'checker_gplmb_bill',
  'check_dam',
  'log_clockout',
  'log_handcuff',
  'CCCDGPLX',
  'check_giayto',
  'dispatch',
  'role',
  'ungtuyen', // Đơn ứng tuyển PD qua nút Discord (thay cho phongvan theo dõi Google Form, bật lại bằng /load phongvan)
  'sync_gcpd',
  'dispatch_gcpd',
  'log_nhansu',
  'dangky_ca',
  'cham_cong',
  'ai', // Trợ lý luật Gemini (/ai), chuyển từ bot "PD AI" cũ. Cần GEMINI_API_KEY trong .env
];
