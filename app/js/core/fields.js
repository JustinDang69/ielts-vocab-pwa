// Sheet column headers -> internal field names. Matching is by header text, never by
// column position, so reordered or extra columns in the Sheet don't break anything.
// Keep in sync with HEADERS in backend/Code.gs.
export const HEADERS = {
  dateAdded: 'Ngày thêm',
  term: 'Từ / Phrase',
  type: 'Loại',
  meaning: 'Nghĩa trong ngữ cảnh',
  ipa: 'IPA',
  context: 'Câu gốc / Ngữ cảnh',
  example: 'Ví dụ bổ sung',
  usage: 'Cách dùng / Collocations',
  skill: 'Kỹ năng nguồn',
  topic: 'Chủ đề',
  source: 'Nguồn / Link',
  status: 'Trạng thái',
  lastReview: 'Ngày ôn gần nhất',
  note: 'Ghi chú / Lỗi dễ nhầm',
  id: 'ID (app)',
};

export const FIELD_KEYS = Object.keys(HEADERS).filter((k) => k !== 'id');

export function normHeader(h) {
  return String(h ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function headerIndex(headerRow) {
  const idx = {};
  const wanted = Object.fromEntries(Object.entries(HEADERS).map(([k, v]) => [normHeader(v), k]));
  headerRow.forEach((h, i) => {
    const k = wanted[normHeader(h)];
    if (k && idx[k] === undefined) idx[k] = i;
  });
  return idx;
}

// Sheet status dropdown values (from "Hướng dẫn"). App-only states such as
// "Chờ Max kiểm tra" are never written into the Sheet.
export const SHEET_STATUSES = ['New', 'Learning', 'Review', 'Mastered'];
