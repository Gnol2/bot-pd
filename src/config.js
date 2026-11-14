export const PREFIX = '!';

// ==========================================
// GOOGLE SPREADSHEET IDs
// ==========================================
export const SHEET_IDS = {
  MAIN: '1e_TIX1_MSlVKtt1TIV3GEhUY4juOpGPe6Wwptpkt-yY', // File chính (Online, Hoa-Don, Incident...)
  HOME: '1WiN4rD5YEyQLHyCbShYnvvSPHqRI0K6drdlcbhZjB9U', // GCPD HOME, Dispatch
  PHONGVAN: '1B1UX4fQduScj_rSZoBMxD0GU8LxqWPR_nDLeUxhY8Vc', // Form tuyển dụng
};

// ==========================================
// DISCORD ROOM IDs (snowflake luôn để dạng chuỗi)
// ==========================================
export const ROOMS = {
  HOA_DON: '1414149636704305162',
  HOA_DON_BV: '1453116362468622538',
  TRA_LOI: '1471614732015243369',
  KPI: '1480076794609664010',
  INCIDENT: '1414548826118684752',
  TAM_GIAM: '1446691326828740718',
  GIAY_TO: '1466646649563517221',
  GPLMB_CMD: '1481547367554748476',
  DOI_BAY: '1464550372096999466',
  DUTY: '1452729913172955287',
  RADIO: '1486234519416864910',
  ROLE: '1516858802081759415',
  CHECK_DAM: '1487524624857301053',
  TOP_113: '1471614732015243369',
  VI_PHAM: '1489438868330778725',
  HANDCUFF: '1471744834581827708',
  CLOCKOUT: '1414548963247390770',
  DISPATCH: '1518939026391040050',
  PHONGVAN: '1538139203194323124',
};

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
];
