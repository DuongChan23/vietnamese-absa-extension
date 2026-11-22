# Nhận xét các notebook Colab ABSA

Ngày đọc: 12/11/2026. Phạm vi: 6 notebook trong `active/`, đối chiếu các policy
và báo cáo NB39/NB46 đang có trong `models/`. Đây là review mã nguồn và output
đã lưu; không chạy lại huấn luyện, không sửa notebook hoặc checkpoint.

## 1. Nhận định chung

Pipeline có cấu trúc rõ, có kiểm tra dữ liệu và truy vết checkpoint, phù hợp
để trình bày một BTL về ABSA. Các output được đọc cho thấy NB46 cải thiện F1
trên DEV so với NB39 khi ghép cùng PhoBERT. Phạm vi bằng chứng hiện tại là
dữ liệu hai miền có source đã biết, chưa phải mọi sản phẩm Shopee.

Hai ưu tiên lớn nhất: làm rõ giao thức chọn model/đánh giá và đồng nhất cách
chọn bộ nhãn giữa notebook với extension. Chưa có căn cứ để kết luận phải
thay kiến trúc hoặc tăng số epoch ngay.

## 2. Vai trò và kết quả từng notebook

| Notebook | Vai trò | Kết quả đọc từ output |
|---|---|---|
| NB01 — Data Preparation | Chuẩn hóa ViCloABSA/ViSD4SA, kiểm tra span, loại trùng, tạo dữ liệu ASC | Clean: TRAIN 12.778, DEV 2.111, TEST 3.225 review; 52.444 annotation/ASC |
| NB04 — PhoBERT ASC | Phân loại sentiment khi được cung cấp aspect/span | DEV Accuracy 94,670%; Macro-F1 86,738%; 6.023 aspect chuẩn |
| NB20 — Category-conditioned Span | XLM-R, boundary/presence heads; khởi tạo cho NB39 | DEV Span F1 63,079%; Span+Category F1 khoảng 60,55% |
| NB39 — Joint Biaffine ACTIVE | Fine-tune encoder và chấm điểm cặp start/end; 2 epoch, tối đa 22.000 train query | DEV Span F1 66,349%; Span+Category F1 64,263%; threshold 0,80 |
| NB46 — Boundary Ranking Pilot | Đóng băng NB39, học MLP residual trên ứng viên | DEV Span F1 66,768%; Span+Category F1 64,826%; chọn epoch 1, threshold 0,85 |
| NB55 — Full ABSA Comparison | Đánh giá NB39+NB04 so với NB39+NB46+NB04 | Full ABSA F1 61,708% → 62,315%; tăng khoảng 0,608 điểm phần trăm theo số chưa làm tròn |

NB20 là model tiền nhiệm cung cấp trọng số; pipeline suy luận cuối không phải
chạy nối tiếp cả NB20 rồi NB39. NB55 là notebook đánh giá, không phải model
huấn luyện độc lập. NB04 có đọc/encode TEST nhưng không tính metric TEST trong
notebook này; không nên diễn đạt rằng chưa từng đọc bất kỳ dữ liệu TEST nào.

## 3. Điểm đã làm tốt

- **Bảo toàn dữ liệu gốc và character offset.** NB01 ghi lại annotation lỗi,
  không tự sửa text rồi dùng lại offset cũ. Có 122 annotation invalid span
  bị loại và có báo cáo riêng.
- **Có kiểm tra trùng nội dung thực sự.** NB01 Cell 9.3–9.4 ưu tiên
  TEST > DEV > TRAIN, loại 7 bản trùng giữa split và 1 bản trùng nội bộ;
  output sau xử lý không còn trùng text theo khóa so sánh giữa các split.
- **ASC được đánh dấu vị trí aspect.** NB04 Cell 3.2/4.1 dùng `[ASP]`,
  `[/ASP]`, tách từ riêng left/aspect/right và cắt ngữ cảnh xa; coverage ASC
  đã lưu là 100% trên cả ba split.
- **Không chèn gold vào suy luận.** NB39 chỉ thêm gold pair khi train.
  NB46 tạo ứng viên bằng `training=False` cả khi học reranker; NB55 tạo query
  suy luận với `gold_spans=[]`.
- **Giữ gold đầy đủ khi tính metric.** Những span không ánh xạ token chính
  xác vẫn nằm trong gold đánh giá; không âm thầm loại để làm đẹp kết quả.
- **Kiểm tra provenance và baseline.** NB39 kiểm tra hash NB20; NB46 đóng
  băng NB39, khởi tạo residual bằng 0 và xác nhận tái tạo đúng baseline;
  NB55 xác minh checkpoint/policy và dùng cùng extractor/ASC cho hai nhánh.
- **Metric được tách theo tầng.** Span, Span+Category, Span+Sentiment và
  Full ABSA được tính riêng; đầu ra NB55 có dự đoán theo từng review.

## 4. Các vấn đề cần ưu tiên

### A. TRAIN holdout chưa độc lập với model tiền nhiệm — ưu tiên cao

NB20 Cell 6.1 huấn luyện trên toàn bộ TRAIN đã encode. NB39 Cell 1 mới chia
TRAIN_SUB/TRAIN_HOLD nhưng lại nạp encoder/boundary/presence từ NB20. Vì vậy,
review của TRAIN_HOLD đã tham gia huấn luyện model nền. NB46 tiếp tục dùng
cùng holdout, vốn còn được dùng để chọn checkpoint NB39.

Điều này không có nghĩa NB39 trực tiếp tối ưu gradient trên holdout trong
vòng train của nó, nhưng holdout không phải tập hoàn toàn chưa được nhìn thấy
bởi toàn pipeline. Notebook đã thừa nhận giới hạn này, đặc biệt qua
`train_holdout_contaminated_by_base: true` trong policy NB46.

**Khuyến nghị:** chia train-fit/calibration trước khi huấn luyện NB20, dùng
cùng phân hoạch cho các tầng sau và không cho NB20 học calibration. Nhóm
theo nội dung review để các bản cùng text/khác annotation không bị tách sang
hai nhóm. Giữ TEST để đánh giá cuối sau khi khóa toàn bộ chính sách.

### B. DEV đã được dùng để chọn model trước đó — ưu tiên cao

NB04 Cell 6.1 chọn checkpoint theo DEV Macro-F1. NB20 Cell 6.1 chọn epoch
và threshold theo DEV exact-span F1. Vì NB39 kế thừa NB20 và NB55 dùng NB04,
DEV cuối không phải một tập đánh giá hoàn toàn độc lập cho toàn hệ thống.

`selected_without_dev` của NB39/NB46 mô tả việc lựa chọn ở các giai đoạn
đó; không xóa sự phụ thuộc DEV của các model tiền nhiệm. Chọn model trên DEV
là quy trình phát triển bình thường, nhưng cần đánh giá TEST độc lập trước
khi kết luận khả năng tổng quát hóa.

### C. “Unified” trong NB55 khác cách extension đang chạy — ưu tiên cao

NB20 Cell 2.2 và NB55 Cell 2 đều dùng `CATS[r['source']]`. Tức là review
thời trang chỉ được xét 5 nhãn thời trang, review điện thoại chỉ được xét
10 nhãn điện thoại. Bộ dữ liệu cung cấp source; notebook chưa tự nhận diện
ngành hàng từ tên sản phẩm.

Ngược lại, extension gửi `source: "unified"`; backend hiện chạy cả hai bộ
nhãn cho mỗi review. Model chưa được huấn luyện/đánh giá theo cách mọi review
đều nhận 15 truy vấn, đặc biệt không có cross-domain negative tương ứng trong
quy trình tạo query đã đọc. Đây là một nguyên nhân có cơ sở cho nhãn điện
thoại xuất hiện ở sản phẩm thời trang khi triển khai.

**Khuyến nghị:** tách rõ source-conditioned evaluation của NB55 với
all-source inference của ứng dụng. Thêm router dựa trên danh mục/tên sản
phẩm, khóa query plan theo phiên phân tích, và đo cả sai số router lẫn ABSA.
Áp dụng nhãn sang đồng hồ hoặc ngành hàng khác phải coi là thử nghiệm ngoài
miền đã đánh giá. Router giảm truy vấn không phù hợp nhưng không bổ sung
kiến thức/ngành hàng mới cho checkpoint.

### D. Chưa tách ảnh hưởng reranker khỏi thay đổi threshold — ưu tiên cao

NB55 so sánh baseline NB39 ở 0,80 và NB39+NB46 ở 0,85. Đây là một so sánh
hợp lệ giữa hai cấu hình đã khóa, nhưng chưa đủ để quy toàn bộ chênh lệch
cho riêng trọng số reranker. Grid của NB39 cũng không có mốc 0,85, còn grid
NB46 có mốc này.

Nên bổ sung ablation:

| Reranker | Threshold |
|---|---|
| Không | 0,80 |
| Không | 0,85 |
| Có | 0,80 |
| Có | 0,85 |

Để so sánh cấu hình tối ưu, cho hai nhánh cùng ngân sách tìm ngưỡng trên
validation/calibration độc lập rồi khóa trước TEST. Không chọn phương án
dựa trên điểm TEST.

### E. F1 tăng nhỏ và đi kèm giảm Recall

Output NB55, cell `Final Unified Full ABSA Evaluation`:

| Full ABSA DEV | Baseline | Proposed |
|---|---:|---:|
| Precision | 62,927% | 67,198% |
| Recall | 60,535% | 58,094% |
| F1 | 61,708% | 62,315% |
| TP | 3.646 | 3.499 |
| FP | 2.148 | 1.708 |
| FN | 2.377 | 2.524 |

Proposed giảm 440 FP nhưng cũng giảm 147 TP. Vì vậy, có bằng chứng rằng nó
lọc chặt hơn; chưa thể nói tăng đồng đều mọi mặt. Chưa thấy kết quả nhiều
seed, khoảng tin cậy hay kiểm định chênh lệch trong 6 notebook này.

**Khuyến nghị:** paired bootstrap theo review, báo cáo riêng từng source
và category, kèm nhiều seed nếu tài nguyên cho phép. Chưa nên khẳng định
chênh lệch 0,608 điểm có ý nghĩa thống kê.

### F. Neutral là điểm yếu rõ của PhoBERT

NB04 Cell 7.2 ghi:

| Sentiment | F1 | Số mẫu DEV |
|---|---:|---:|
| Negative | 94,02% | 1.402 |
| Neutral | 68,77% | 423 |
| Positive | 97,42% | 4.198 |

Train có 2.564 neutral trên 36.935 mẫu, ít hơn nhiều hai lớp còn lại.
Accuracy 94,67% không mô tả đầy đủ hiệu quả trên neutral. Có thể thử class
weights/sampling trên TRAIN và chọn theo validation Macro-F1; không mặc định
coi mất cân bằng là nguyên nhân duy nhất hoặc thay loss sẽ chắc chắn tốt hơn.

Điểm NB04 dùng aspect chuẩn. Nó không phải Accuracy/F1 của pipeline phải tự
tìm cả span, category và sentiment. NB55 mới đo điều kiện đó.

### G. NB46 có giới hạn từ ứng viên NB39

NB46 chỉ điều chỉnh điểm trong tập top-48 cặp được tạo từ top-12 start và
top-16 end. Nó không tạo span mới ngoài tập đó. Quy tắc giải mã còn giới hạn
4 span/query và loại span chồng lấn cùng category.

DEV có 178 annotation không biểu diễn chính xác theo offset/tokenization
trong cấu hình này (coverage NB20 97,04%). Đây là giới hạn cần được báo cáo;
không phải toàn bộ khoảng cách F1 đều do những annotation này.

**Khuyến nghị:** đo proposal recall trước reranker, thống kê gold bị mất vì
offset, top-K, giới hạn số span và overlap. Chỉ tăng độ phức tạp model sau
khi biết tầng nào làm mất nhiều gold nhất.

### H. Một số bằng chứng và tài liệu còn cần hoàn thiện

- NB01 Cell 9.4 vẫn là `passed_with_review_pending`: còn 5 trường hợp cùng
  nội dung nhưng annotation khác. Chưa thấy bằng chứng giải quyết chúng trong
  các notebook được cung cấp; cần audit thủ công trước lần train tiếp theo.
- NB01 phần tổng kết còn dùng số baseline 18.122 review, trong khi các model
  sau dùng clean 18.114 review. Nên có bảng trước/sau để tránh nhầm dữ liệu.
- NB39 phần markdown đánh giá DEV ghi chưa có output cuối, nhưng Cell 6 đã
  lưu Span F1 66,349% và Span+Category F1 64,263%. Cần cập nhật lời mô tả.
- NB04 cho phép `transformers<6`, trong khi các notebook sau yêu cầu `<5`.
  Đã phải xử lý tương thích `extra_special_tokens`. Nên lưu phiên bản thực tế,
  revision pretrained model và lock dependencies cho lần tái lập.
- NB55 chỉ giữ `BY_SOURCE` nếu biến này có sẵn trong session; chưa thấy cell
  tự tính biến đó trong file. Nên tính per-source một cách tường minh, không
  phụ thuộc biến còn sót từ lần chạy trước.
- Presence head được học ở NB39 nhưng điểm presence không tham gia giải mã
  trong NB39/NB55. Có thể thử làm tín hiệu reject category ở một ablation riêng;
  không nên bật ngay mà chưa hiệu chỉnh và đánh giá Precision/Recall.

## 5. Thứ tự cải tiến đề xuất

1. Sửa cách chọn bộ nhãn trong ứng dụng và tạo bộ review Shopee có nhãn thủ
   công đại diện cho các loại sản phẩm cần demo. Đánh giá lại cấu hình router.
2. Giải quyết 5 annotation conflict, bổ sung báo cáo theo source/category và
   phân tích FP/FN cụ thể.
3. Bổ sung ablation threshold/reranker, proposal recall và khoảng tin cậy.
4. Nếu huấn luyện lại, chia calibration trước NB20 và giữ phân hoạch chung
   xuyên các giai đoạn; thử nhiều seed hoặc mở rộng TRAIN sau khi biết lỗi chính.
5. Khóa pipeline và đánh giá TEST độc lập. Chỉ so sánh với Gemini hay phương
   pháp khác khi cùng input, bộ nhãn và tiêu chí chấm.

## 6. Cách trình bày kết quả hiện có

Có thể viết:

> Trên DEV gồm 2.111 review thuộc hai nguồn dữ liệu đã biết, cấu hình
> NB39+NB46+NB04 đạt Full ABSA micro-F1 62,315%, so với 61,708% của
> NB39+NB04. Precision tăng và Recall giảm. Kết quả là đánh giá phát triển;
> chưa chứng minh hiệu quả trên TEST độc lập hoặc các ngành hàng Shopee khác.

Không nên gọi Accuracy 94,67% của NB04 là độ chính xác tổng thể của extension,
hoặc gọi mức tăng F1 hiện có là hiệu quả đã được xác nhận cho mọi sản phẩm.
