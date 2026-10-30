# Vietnamese ABSA Shopee — Hướng dẫn cài đặt và chạy thử

> **Phiên bản tài liệu:** 30/10/2026 · **Phạm vi:** chạy hệ thống cục bộ trên Windows 10/11, gồm FastAPI và Chrome Extension. Hướng dẫn được đối chiếu với `backend/main.py`, `backend/inference.py`, `extension/manifest.json`, các module thu thập/batch và báo cáo dự án hiện có. **Không phải hướng dẫn huấn luyện lại các notebook Colab.**

## 1. Chức năng hệ thống

Hệ thống phân tích bình luận tiếng Việt theo **khía cạnh** (Aspect-Based Sentiment Analysis — ABSA):

1. **NB39 — XLM-R Joint Biaffine:** đề xuất đoạn khía cạnh (span) và nhóm khía cạnh (category).
2. **NB46 — Whole-Span Boundary Reranker:** xếp hạng và lựa chọn lại các ứng viên NB39 đã tạo.
3. **NB04 — PhoBERT ASC:** dự đoán cảm xúc `positive`, `neutral` hoặc `negative` cho mỗi đoạn được giữ lại.

**NB55** là notebook **đánh giá**, không phải checkpoint chạy trên backend. Chrome Extension gửi yêu cầu HTTP tới FastAPI; model được tải và chạy ở máy có FastAPI, không chạy trực tiếp trong trình duyệt.

```text
Chrome/Shopee → Extension (Side Panel) → FastAPI :8000
                                            │
                           NB39 → NB46 → NB04
                                            │
                   JSON (span/category/sentiment) → Side Panel
```

## 2. Yêu cầu trước khi chạy

- **Windows 10/11**, Command Prompt (CMD) hoặc PowerShell.
- **Python 3.11** (cấu hình chạy local trước đó dùng 3.11.9).
- **Java** có thể chạy được lệnh `java -version` (máy thử trước đây dùng Java 21.0.2).
- **Google Chrome** có tính năng Manifest V3 Side Panel.
- Mã nguồn **đủ các thư mục `backend/`, `extension/`, `models/`, `vncorenlp/`**.
- Các **checkpoint đã huấn luyện** tải từ Drive của nhóm; repository nguồn không nhất thiết có các tệp lớn này.
- Kết nối mạng lúc cài thư viện và có thể khi XLM-R tải trọng số nền lần đầu. Việc chạy sau đó có thể sử dụng cache đã tải.

> **Quan trọng:** Nếu chỉ có slide/README mà chưa có source code hoặc checkpoint thì **chưa thể chạy dự đoán AI**. File README này không tự cung cấp trọng số mô hình.

## 3. Kiểm tra cấu trúc thư mục

Đặt `README.md` tại thư mục gốc của project, cùng cấp với `backend/`, `extension/`, `models/`:

```text
vietnamese-absa-extension/           # ví dụ tên thư mục project
├── README.md
├── backend/
│   ├── main.py
│   ├── inference.py
│   ├── preprocessing.py
│   ├── category_normalizer.py
│   └── requirements.txt
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── collectors/
│   │   ├── product_collector.js
│   │   └── review_collector.js
│   └── services/
│       ├── batch_service.js
│       └── analytics_service.js
├── models/
│   ├── ate_category_conditioned_v1/model/
│   │   ├── conditional_span.pt
│   │   ├── model_config.json
│   │   └── ... các file tokenizer từ NB20
│   ├── absa_joint_biaffine_span_pair_v1/
│   │   ├── joint_best.pt
│   │   └── locked_policy.json
│   ├── absa_joint46_boundary_ranking_pilot_v1/
│   │   ├── reranker_best.pt
│   │   └── pilot_policy.json
│   └── phobert_asc_training/model/
│       ├── model.safetensors       # hoặc file trọng số tương ứng
│       ├── config.json
│       ├── tokenizer_config.json
│       ├── bpe.codes
│       ├── vocab.txt
│       └── ... các file tokenizer cần thiết
├── vncorenlp/
│   ├── VnCoreNLP-1.2.jar
│   └── models/wordsegmenter/
│       ├── vi-vocab
│       └── wordsegmenter.rdr
└── tests/                         # nếu có mã kiểm thử
```

**Không** đặt toàn bộ file `.py` và `.js` chung trong thư mục gốc: `main.py` dùng các import tương đối (`.inference`, `.preprocessing`, ...), còn extension tham chiếu `collectors/` và `services/` theo đường dẫn riêng.

### Phiên bản checkpoint cần khớp

| Thành phần | SHA-256 đã ghi trong thí nghiệm ACTIVE |
|---|---|
| NB20 — `conditional_span.pt` | `775be14671de87c03ef228b19ef199f70f70a57b000463f382f517137f1b2944` |
| NB39 — `joint_best.pt` | `b32923b7e9db9713354ccaaad4b21390ce621f34ddeeb4d9d37a0e65722c5262` |
| NB46 — `reranker_best.pt` | `49f60b8027c0dce029f72365bb2c3de5bd4587e5f65cdede593374cd4bae242b` |

Trong Windows CMD, tính hash để đối chiếu:

```bat
certutil -hashfile models\absa_joint_biaffine_span_pair_v1\joint_best.pt SHA256
certutil -hashfile models\absa_joint46_boundary_ranking_pilot_v1\reranker_best.pt SHA256
```

Backend **kiểm tra** rằng hash checkpoint NB39 trùng với `base_checkpoint_sha256` trong `pilot_policy.json` của NB46. Nếu dùng nhầm hai phiên bản, backend sẽ không sẵn sàng.

## 4. Cài môi trường Python trên Windows

Mở **CMD**, chuyển vào thư mục project thực tế (thay đường dẫn dưới bằng đường dẫn trên máy bạn):

```bat
cd /d "C:\duong-dan\vietnamese-absa-extension"
py -3.11 --version
java -version
py -3.11 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
python -m pip install torch protobuf
```

Nếu máy có GPU NVIDIA, hãy cài bản PyTorch tương ứng với driver/CUDA theo trang chính thức <https://pytorch.org/get-started/locally/>. **CPU vẫn có thể chạy**, nhưng việc tải model và suy luận sẽ chậm hơn nhiều.

Nếu bạn dùng **PowerShell**, câu lệnh kích hoạt môi trường là:

```powershell
.\.venv\Scripts\Activate.ps1
```

Nếu PowerShell chặn script, có thể dùng **CMD** với `activate.bat` hoặc chạy trực tiếp `.venv\Scripts\python.exe` mà không cần kích hoạt môi trường.

### Kiểm tra VnCoreNLP

Dữ liệu VnCoreNLP lấy từ dự án chính thức: <https://github.com/vncorenlp/VnCoreNLP>. Kiểm tra đủ file jar và bộ `wordsegmenter` như cấu trúc ở mục 3. Trên Windows, tải thủ công bộ dữ liệu có thể dễ hơn dùng lệnh tải tự động.

Sau đó thử (từ thư mục gốc, khi môi trường Python đã kích hoạt):

```bat
python -c "import py_vncorenlp,os; p=os.path.abspath('vncorenlp'); m=py_vncorenlp.VnCoreNLP(annotators=['wseg'],save_dir=p); print(m.word_segment('Điện thoại có màn hình đẹp nhưng pin yếu.'))"
```

Nếu in ra danh sách câu đã tách từ, bộ tách từ hoạt động. VnCoreNLP được sử dụng ở nhánh **PhoBERT ASC**, không phải bộ sửa lỗi chính tả/từ viết tắt tự động.

## 5. Khởi động FastAPI Backend

Trong **CMD số 1** tại thư mục gốc project (đang bật `.venv`):

```bat
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

**Không** chạy `python main.py` trong thư mục `backend` khi cấu trúc code dùng relative imports. **Không** thêm `--reload` trong buổi demo nếu muốn tránh tải lại những checkpoint lớn không cần thiết.

Lần khởi động có thể chậm do phải tải NB39, NB46, PhoBERT và VnCoreNLP vào bộ nhớ. **Không kết luận đã sẵn sàng chỉ vì Uvicorn bắt đầu nghe cổng**; luôn kiểm tra `/health`.

Mở trình duyệt:

- **Health:** <http://127.0.0.1:8000/health>
- **Swagger API:** <http://127.0.0.1:8000/docs>

Kết quả `/health` phải có `"ready": true`. Nếu `"ready": false`, xem giá trị `"error"` hoặc console CMD số 1 để tìm lỗi nạp mô hình. HTTP 200 của `/health` **không** có nghĩa mô hình đã sẵn sàng: phải kiểm tra trường `ready`.

## 6. Chạy thử API trước khi mở Extension

Mở **PowerShell số 2**. Đảm bảo Backend vẫn chạy trong CMD số 1.

### Bước 6.1 — Kiểm tra trạng thái

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/health" | ConvertTo-Json -Depth 5
```

### Bước 6.2 — Phân tích một bình luận

```powershell
$payload = @{
    text = "Áo đẹp nhưng chất vải hơi mỏng, giao hàng nhanh."
    source = "unified"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
    -Uri "http://127.0.0.1:8000/predict" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) |
    ConvertTo-Json -Depth 10
```

Kết quả JSON **có thể** bao gồm:

- `text`: văn bản gốc;
- `source`: ví dụ `unified`;
- `aspects`: **dự đoán gốc**, gồm `aspect`, `start`, `end`, `category`, `sentiment`;
- `aspects_merged`: bản gộp nhãn tương đương để hỗ trợ giao diện;
- `model`: `NB39+NB46+NB04`;
- `evaluation_note`: cảnh báo tương ứng với chế độ suy luận.

Kết quả span/category/sentiment **phụ thuộc checkpoint**, không nên chép cố định JSON dự đoán để coi là đáp án đúng. Bạn cũng có thể thử `"source": "vicloabsa"` (nhãn miền quần áo) hoặc `"source": "visd4sa"` (nhãn miền điện thoại) với đúng category ontology của dữ liệu đó.

### Bước 6.3 — Phân tích nhiều bình luận

```powershell
$batch = @{
    source = "unified"
    product_id = "demo-product-001"
    reviews = @(
        @{ review_id="r01"; text="Áo đẹp nhưng chất vải hơi mỏng."; rating=4 },
        @{ review_id="r02"; text="Giao hàng nhanh, đóng gói cẩn thận."; rating=5 },
        @{ review_id="r03"; text="Shop giao chậm quá!"; rating=2 }
    )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
    -Uri "http://127.0.0.1:8000/predict/batch" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($batch)) |
    ConvertTo-Json -Depth 12
```

Ở kết quả batch, kiểm tra các khóa `results`, `preprocessing`, `rejected` và `status` của từng bình luận. API chỉ nhận **tối đa 30 bình luận mỗi request**; Extension tự chia thành **các lô 10 bình luận**.

**Lưu ý:** `source: "unified"` là chế độ thực nghiệm kết hợp các bộ category của hai nguồn. **Không dùng F1 của NB55 để khẳng định hiệu năng của chế độ `unified`**, vì NB55 đánh giá theo `source` xác định sẵn của từng review.

## 7. Chạy thử Chrome Extension trên Shopee

1. Đảm bảo Backend đang chạy và `/health` trả `ready: true`.
2. Mở Chrome, nhập `chrome://extensions`.
3. Bật **Developer mode** (Chế độ dành cho nhà phát triển).
4. Chọn **Load unpacked** (Tải tiện ích đã giải nén).
5. **Chọn thư mục `extension/`** — đây là thư mục có file `manifest.json`.
6. Mở một **trang sản phẩm Shopee Việt Nam** (`https://shopee.vn/...`) và để phần đánh giá tải xong.
7. Nhấn biểu tượng Extension để mở **Side Panel**.

### Cách A — Demo nhanh một bình luận (ít phụ thuộc giao diện Shopee)

- Dán văn bản vào ô **Nội dung đánh giá**.
- Nhấn **Phân tích**.
- Xem các khía cạnh và nhãn cảm xúc hiển thị.
- Hoặc bôi đen một đoạn văn bản trên trang, nhấn **Lấy văn bản được chọn**, rồi **Phân tích**.

### Cách B — Demo theo một sản phẩm Shopee

- Nhấn **Lấy thông tin sản phẩm Shopee** để xem thông tin sản phẩm khi collector đọc được từ trang.
- Chọn mục tiêu **50 / 100 / 200 bình luận**.
- Nhấn **Lấy bình luận Shopee** và xem số review thực tế thu thập được, số sao, lý do dừng.
- Nhấn **Phân tích tất cả bình luận đã lấy**.
- Theo dõi tiến độ các batch, thống kê category/sentiment, xem danh sách review.
- Nếu giao diện hiện các nút xuất, dùng **Xuất JSON / Xuất CSV** để lưu dữ liệu thử nghiệm.

**Lưu ý về collector:** Đọc bình luận từ **DOM đang hiển thị** trên trang Shopee và tùy trạng thái tải trang/phân trang. Không bảo đảm thu đủ 50/100/200 bình luận với mọi sản phẩm; không sử dụng để vượt quyền truy cập hoặc cơ chế bảo vệ của website. Đây là prototype, không phải dịch vụ scraping độc lập đã kiểm thử trên mọi thay đổi giao diện Shopee.

## 8. Tự kiểm tra trước buổi demo

- [ ] Mở đúng thư mục project, nhìn thấy `backend/main.py` và `extension/manifest.json`.
- [ ] `python --version` là bản Python đúng trong `.venv`.
- [ ] `java -version` hoạt động; file VnCoreNLP đầy đủ.
- [ ] Đúng các checkpoint, tokenizer và file policy; hash NB39/NB46 khớp.
- [ ] Chạy `python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`.
- [ ] `/health` có `"ready": true`.
- [ ] Thử `/predict` bằng văn bản tự nhập.
- [ ] Thử `/predict/batch` với 2–3 bình luận trước khi chạy số lượng lớn.
- [ ] Chrome đã tải Extension từ thư mục `extension/`.
- [ ] Trang sản phẩm Shopee đã hiển thị phần bình luận.
- [ ] Lấy được một số review, phân tích và xuất dữ liệu (nếu collector hỗ trợ trang hiện tại).

Nếu có các file unit test `tests/test_preprocessing.py`, `tests/test_category_normalizer.py`, có thể chạy từ gốc dự án:

```bat
python -m unittest discover -s tests -p "test_*.py" -v
```

Kiểm thử preprocessing/normalizer chỉ kiểm tra **logic phần mềm**, không thay thế đánh giá F1 của mô hình AI.

## 9. Xử lý lỗi thường gặp

| Triệu chứng | Nguyên nhân có thể | Cách xử lý |
|---|---|---|
| `'py' is not recognized` | Không có Python Launcher hoặc Python chưa cài | Kiểm tra `python --version`; cài đúng Python 3.11 |
| `No module named uvicorn / fastapi` | Chưa cài dependencies hoặc dùng sai `.venv` | Kích hoạt `.venv`, chạy `python -m pip install -r backend\requirements.txt` |
| `ModuleNotFoundError: backend` | Chạy lệnh không ở gốc project hoặc thiếu cấu trúc `backend/` | `cd` về thư mục có `backend/`, chạy `python -m uvicorn backend.main:app ...` |
| `ready: false` | Backend chạy HTTP nhưng lỗi nạp model | Xem `error` trong `/health`; kiểm tra model/tokenizer/VnCoreNLP |
| `FileNotFoundError` / thiếu checkpoint | Chưa copy đủ file model/Drive | Đối chiếu cây thư mục ở mục 3 |
| `NB39/NB46 SHA mismatch` | Checkpoint hoặc policy không cùng lần huấn luyện | Copy lại đúng checkpoint NB39, NB46 và policy tương ứng; **không sửa hash để bỏ kiểm tra** |
| Lỗi Java/VnCoreNLP | Thiếu JAR hoặc `models/wordsegmenter`, Java chưa hoạt động | Kiểm tra thư mục `vncorenlp/`, thử lệnh mục 4 |
| Hết RAM / khởi động rất chậm | XLM-R + PhoBERT chiếm nhiều tài nguyên | Đóng ứng dụng nặng, ưu tiên GPU phù hợp, thử một bình luận trước |
| Extension không mở/không có Side Panel | Sai thư mục hoặc không có `manifest.json`/`background.js` | Load unpacked đúng `extension/`, bấm **Reload** ở `chrome://extensions` |
| Extension không kết nối Backend | Backend chưa chạy/port khác/`ready: false` | Thử `http://127.0.0.1:8000/health`, giữ port 8000 |
| `HTTP 422` | Text rỗng/quá dài, source không hợp lệ, batch quá 30 review | Kiểm tra `/docs` và dữ liệu JSON gửi lên |
| Thu thập ít review hơn mục tiêu | Bình luận chưa tải, pagination thay đổi, DOM Shopee thay đổi | Chờ tải trang, thử sản phẩm khác; kiểm tra thông tin diagnostics/stop reason |
| Không có aspect hoặc category không mong muốn | Mô hình không tìm được span hoặc chế độ `unified` dùng hai bộ nhãn | Thử câu đơn giản, nguồn `vicloabsa`/`visd4sa`; không coi dự đoán là gold |

## 10. Giới hạn nghiên cứu và cách trình bày kết quả

- **NB55 DEV**, với source đã biết: Full ABSA F1 **61,708% (Baseline NB39+NB04)** → **62,315% (Proposed NB39+NB46+NB04)**, tăng xấp xỉ **0,608 điểm phần trăm** theo số chưa làm tròn. Đây **không phải** F1 được kiểm chứng cho chế độ local `unified` hoặc dữ liệu Shopee.
- Một thử nghiệm Shopee trong báo cáo có **100 review, 217 lượt aspect dự đoán**; đó là **thống kê vận hành**, không phải Accuracy hay F1 vì chưa có gold đầy đủ.
- Chưa có module chuyên biệt để **sửa lỗi chính tả, mở rộng từ viết tắt hoặc khôi phục dấu**. Hệ thống giữ nguyên văn bản gốc để bảo toàn offset. Model có thể khai thác ngữ cảnh nhưng không bảo đảm hiểu đúng mọi cách viết không chuẩn.
- Khả năng thu thập phụ thuộc quyền truy cập, DOM hiện tại và nội dung hiển thị trên Shopee.
- Không đưa checkpoint/dữ liệu cá nhân/khóa bí mật vào Git công khai. Việc phân phối trọng số và dữ liệu phải tuân thủ điều kiện sử dụng tương ứng.

---

### Tóm tắt 5 lệnh chạy nhanh (Windows CMD)

Chạy tại **thư mục gốc project**, sau khi đã có đầy đủ source, model và VnCoreNLP:

```bat
py -3.11 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install -r backend\requirements.txt
python -m pip install torch protobuf
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

**Bước tiếp theo:** Mở <http://127.0.0.1:8000/health> (phải có `ready: true`), thử `/predict` trong <http://127.0.0.1:8000/docs>, rồi tải Chrome Extension qua `chrome://extensions`.
