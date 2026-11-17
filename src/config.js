export const PREFIX = '!';

// Role được dùng toàn bộ lệnh quản lý của bot (đổi tên role trên Discord thì sửa ở đây)
export const BOT_ADMIN_ROLE = 'PD bot admin';

// ==========================================
// GOOGLE SPREADSHEET IDs
// ==========================================
export const SHEET_IDS = {
  MAIN: '1OQNQWjXuZ8wOd926L4WjR2BFabQjZ4x-GAT72E6nOb0', // File chính "GCPD DATA" (Online, Hoa-Don, Incident, tab KPI tuần...)
  HOME: '17khpbSoq5CvPDqJAsBD1oSbveM-O6Z_EgfxIi6Topmo', // GCPD HOME, Dispatch
  PHONGVAN: '18sRWnDVttvBC26iKukbwgBgoEEQLCh4GhAavIIz0DDI', // Form tuyển dụng
  LUONG: '1ec1PDrI9V4hlQCWf_1KRApeEpX3FVkJdTftSUClNnqU', // File Lương GCPD: tab tuần "d/m-d/m", bot ghi giờ ON-OFF vào cột E..K
};

// ==========================================
// DISCORD ROOM IDs (snowflake luôn để dạng chuỗi)
// ==========================================
export const ROOMS = {
  HOA_DON: '1414149636704305162',
  HOA_DON_BV: '1453116362468622538',
  TRA_LOI: '1571029495689777213',
  KPI: '1571029274646028400',
  INCIDENT: '1414548826118684752',
  TAM_GIAM: '1446691326828740718',
  GIAY_TO: '1466646649563517221',
  GPLMB_CMD: '1571029360893362186',
  DOI_BAY: '1571029387082596542',
  DUTY: '1452729913172955287',
  RADIO: '1486234519416864910',
  ROLE: '1516858802081759415',
  CHECK_DAM: '1571029462185943201',
  TOP_113: '1571029495689777213',
  VI_PHAM: '1571029523598811239',
  HANDCUFF: '1471744834581827708',
  CLOCKOUT: '1414548963247390770',
  DISPATCH: '1518939026391040050',
  PHONGVAN: '1571029642377429114',

  DANG_KY_CA: '1571551051318829086', // Kênh dùng lệnh đăng ký ca trực (!dangky, !huyca, !lichtruc...). Để trống '' = dùng ở mọi kênh

  // Kênh riêng cho từng loại cảnh báo vi phạm. Để trống '' = gửi vào VI_PHAM như cũ.
  VP_MOMO_LA: '1571438806639579216', // Momo lạ vừa OnDuty (log_nhansu)
  VP_CONG_NGOAI: '1571438872410198157', // Người ngoài danh sách dùng còng tay (log_handcuff)
  VP_CONG_OFFDUTY: '1571438920007155732', // Cảnh sát OFF DUTY dùng còng tay (log_handcuff)
  VP_SUA_MDT: '1571438967566377001', // Chỉnh sửa MDT trái phép (log_incident)
  VP_DAM: '1571439008222023693', // Danh sách vi phạm đàm cuối ngày (check_dam)
};

// Lấy ID kênh cảnh báo: dùng kênh riêng nếu đã điền, không thì rơi về VI_PHAM
export const alertRoom = (key) => ROOMS[key] || ROOMS.VI_PHAM;

export const FIREBASE_URL =
  'https://dispatch-gcpd-default-rtdb.asia-southeast1.firebasedatabase.app/latest_dispatch.json';

// Các module tự load khi khởi động (giống cogs_list trong main.py).
// hoadonbv có file nhưng không có trong danh sách gốc -> bật bằng lệnh `!load hoadonbv`.
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
  'phongvan',
  'sync_gcpd',
  'dispatch_gcpd',
  'log_nhansu',
  'dangky_ca',
  'cham_cong',
];
