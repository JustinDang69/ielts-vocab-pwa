// DEMO DATA ONLY. These entries are samples written for the demo mode; they are NOT
// from Justin's Sheet, and their "Câu gốc" sentences are demo sentences, not real sources.
const d = '2026-01-01';
const mk = (id, term, type, meaning, context, example, usage, note, ipa = '', topic = 'Demo') => ({
  id, row: 0, inSheet: true, demo: true,
  fields: {
    dateAdded: d, term, type, meaning, ipa, context, example, usage,
    skill: 'Demo', topic, source: 'Dữ liệu mẫu (demo)', status: 'New', lastReview: '', note,
  },
});

export const DEMO_ENTRIES = [
  mk('demo-01', 'mitigate', 'Word', 'Giảm nhẹ, làm dịu bớt (tác hại, rủi ro); trong câu: giảm tác động của lũ.',
    'Planting trees along the river helped to mitigate the impact of flooding.',
    'Good planning can mitigate risks. (Lập kế hoạch tốt có thể giảm thiểu rủi ro.)',
    'mitigate the impact/effects/risk', 'Không dùng "mitigate against" trong văn viết trang trọng.', '/ˈmɪtɪɡeɪt/', 'Environment'),
  mk('demo-02', 'scrutinise', 'Word', 'Xem xét kỹ lưỡng, soi xét từng chi tiết.',
    'Inspectors scrutinised every document before approving the project.',
    'The data was carefully scrutinised. (Dữ liệu được xem xét kỹ lưỡng.)',
    'scrutinise a proposal/document; closely scrutinise', 'Anh: scrutinise; Mỹ: scrutinize.', '/ˈskruːtɪnaɪz/', 'Government'),
  mk('demo-03', 'a growing body of evidence', 'Phrase', 'Ngày càng nhiều bằng chứng.',
    'There is a growing body of evidence that sleep affects memory.',
    '', 'a growing body of evidence suggests/shows that…', 'Đi với động từ số ít: "a body of evidence suggests".', '', 'Science'),
  mk('demo-04', 'adverse', 'Word', 'Bất lợi, có hại.',
    'The drug had no adverse effects on the patients in the trial.',
    'Adverse weather delayed the flights. (Thời tiết bất lợi làm chuyến bay bị hoãn.)',
    'adverse effects/conditions/impact', 'Dễ nhầm với averse (= không thích): "risk-averse".', '/ˈædvɜːs/', 'Health'),
  mk('demo-05', 'curb', 'Word', 'Kiềm chế, hạn chế (sự tăng trưởng, thói quen).',
    'The city introduced new taxes to curb car use in the centre.',
    'We need to curb spending. (Chúng ta cần hạn chế chi tiêu.)',
    'curb emissions/spending/use', 'Gần nghĩa: restrict, limit.', '/kɜːb/', 'Transport'),
  mk('demo-06', 'curb', 'Word', 'Lề đường (tiếng Mỹ, = kerb trong tiếng Anh-Anh).',
    'The taxi stopped right next to the curb.',
    '', 'pull up to the curb', 'Cùng chữ "curb" nhưng là danh từ, nghĩa hoàn toàn khác.', '/kɜːb/', 'Transport'),
  mk('demo-07', 'restrict', 'Word', 'Giới hạn, hạn chế trong một phạm vi nhất định.',
    'Access to the library is restricted to students.',
    '', 'restrict access/movement; be restricted to', 'Gần nghĩa: curb, limit.', '/rɪˈstrɪkt/', 'Education'),
  mk('demo-08', 'unprecedented', 'Word', 'Chưa từng có tiền lệ.',
    'The region experienced an unprecedented rise in temperatures last summer.',
    '', 'unprecedented levels/scale/growth', '', '/ʌnˈpresɪdentɪd/', 'Environment'),
  mk('demo-09', 'tangible', 'Word', 'Hữu hình, cụ thể, có thể thấy rõ.',
    '', 'The plan brought tangible benefits to farmers. (Kế hoạch mang lại lợi ích cụ thể cho nông dân.)',
    'tangible benefits/results/evidence', 'Chưa có câu gốc (demo).', '/ˈtændʒəbl/', 'Economy'),
  mk('demo-10', 'take into account', 'Phrase', 'Tính đến, cân nhắc (một yếu tố).',
    'The study did not take into account the age of the participants.',
    '', 'take something into account; take into account the fact that…', '', '', 'Science'),
];
