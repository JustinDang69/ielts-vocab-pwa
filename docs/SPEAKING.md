# Kết quả Speaking → app (tab "Speaking Results")

## Luồng

```
Chatbot Speaking ──(thêm 1 hàng / kết quả)──▶ Google Sheet "Ielts Words and Phrases"
                                               └─ tab "Speaking Results"
App mở / có mạng ─▶ Apps Script (sync) ─▶ đọc hàng chưa xử lý ─▶ 1 sự kiện "speaking" / hàng
                                       └─ ghi "✓ …" / "✗ …" vào cột "Xử lý (app)"
App ─▶ tải sự kiện về ─▶ tính lại tiến độ + lịch ôn ─▶ ghi Trạng thái / Ngày ôn gần nhất lên Sheet
```

- Không có API hay token cho chatbot. Chatbot ghi bằng **quyền Google của chính nó** vào tab này. Token của app không bao giờ xuất hiện trong chat.
- Tab được backend tạo tự động ở lần đồng bộ đầu tiên sau khi cập nhật `Code.gs` (hoặc khi chạy `setup`).

## Định dạng tab

| Cột | Bắt buộc | Giá trị |
|---|---|---|
| `ID (app)` | ✔ | ID của từ trong tab *Vocab & Phrases* (dạng `v-xxxxxxxx`). Nếu để trống mà `Từ / Phrase` khớp **đúng một** hàng thì app tự suy ra ID. ID bắt đầu bằng `TEST` = hàng thử, không tính. |
| `Từ / Phrase` | nên có | Dùng để kiểm tra chéo: nếu khác với từ của ID thì hàng bị từ chối. |
| `Thời gian` | nên có | `YYYY-MM-DD HH:mm` (giờ Sydney), hoặc ô kiểu ngày giờ. Để trống = lúc app nhận. Thời điểm ở tương lai bị từ chối. |
| `Cách dùng` | ✔* | `pass` · `needs_work` · `not_assessed` (cũng chấp nhận: Đạt / Chưa đạt / Chưa đánh giá) |
| `Mức hỗ trợ` | nên có | `none` (tự nói, không gợi ý) · `hint` (có gợi ý) · `model` (nhắc lại câu mẫu). Để trống = coi như **có hỗ trợ**. |
| `Phát âm` | ✔* | `pass` · `needs_work` · `not_assessed` |
| `Bằng chứng phát âm` | | `audio` · `transcript` · `none`. Nếu không phải `audio` thì Phát âm luôn bị đổi thành `not_assessed`. |
| `Câu Justin nói`, `Nhận xét`, `Nguồn` | | Văn bản (hiện trong app). |
| `Xử lý (app)` | — | **App tự ghi.** Chatbot để trống. |

\* Phải có ít nhất một trong hai cột `Cách dùng` / `Phát âm` có kết quả.

**Xử lý đúng một lần:** hàng đã có `Xử lý (app)` thì bỏ qua. Mã sự kiện là mã băm của nội dung hàng, nên kể cả khi việc đánh dấu bị lỗi hay ai đó xoá ô đánh dấu, hàng đó cũng không bị tính lại. Hàng có `✗ …` thì không được tính; sửa hàng rồi **xoá ô `Xử lý (app)`** là app sẽ đọc lại.

## Ảnh hưởng tới tiến độ (`app/js/core/state.js`)

| Kết quả | Tiến độ nhớ | Lịch ôn |
|---|---|---|
| Cách dùng `pass` + Mức hỗ trợ `none` | +1 **ngày tự nhớ trong ngữ cảnh** (tính vào quy tắc 3 ngày) | lên 1 hộp → giãn lịch |
| Cách dùng `pass` + `hint`/`model`/trống | không tính là tự nhớ | giữ hộp |
| Cách dùng `needs_work` | lần tự nhớ gần nhất = chưa đạt (nếu `none`) | xuống 1 hộp, ôn lại ngày mai |
| chỉ có Phát âm | chỉ ghi lịch sử | không đổi |
| Phát âm `pass`/`needs_work` + `audio` | ghi nhận phát âm (hiện trong chi tiết từ) | không đổi |

- Mỗi ngày chỉ lần chấm đầu tiên (ôn trong app **hoặc** Speaking) được dịch hộp.
- **Từ đã thuộc vẫn giữ là đã thuộc.** Kết quả tốt được tính như một lần ôn duy trì; kết quả `needs_work` chỉ đưa lần ôn duy trì lên sớm hơn. Speaking không bao giờ xoá hay bỏ thuộc một từ.
- App không bao giờ gửi được sự kiện `speaking`: backend chỉ tạo loại sự kiện này từ tab trên.

## Kiểm tra quyền ghi của chatbot (làm trước)

Dán vào chatbot:

> Trước khi luyện, hãy thử GHI vào Google Sheet "Ielts Words and Phrases", tab "Speaking Results": thêm một hàng mới ở cuối với `ID (app)` = `TEST-WRITE`, `Từ / Phrase` = `test`, `Cách dùng` = `not_assessed`, `Nguồn` = tên của bạn; các cột khác để trống. Sau đó cho mình biết (1) bạn dùng công cụ / kết nối nào để ghi, (2) đã ghi thành công chưa. Nếu bạn không có công cụ ghi Google Sheets thì nói thẳng là không ghi được, đừng giả lập.

Sau đó **tự mở Sheet kiểm tra** (đừng chỉ tin lời bot). Mở app và đồng bộ: ô `Xử lý (app)` của hàng thử sẽ thành `🧪 App đã nhận hàng thử …`. Lúc đó toàn bộ đường đi đã chạy thật.

## Prompt cho chatbot Speaking

Xem phần "Prompt" trong câu trả lời bàn giao. Bản dùng lâu dài nên đặt vào **hướng dẫn của Project / GPT riêng của bạn**, để không phải dán lại mỗi buổi.
