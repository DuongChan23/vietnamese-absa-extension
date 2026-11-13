# Rà soát để triển khai công khai — 13/11/2026

Đã giữ nguyên checkpoint, kiến trúc NB39 → NB46 → NB04, ngưỡng chọn span và phép tính suy luận. Không bật batch lớn hơn hoặc khẳng định tăng tốc khi chưa benchmark trên EC2.

## Thay đổi đã thực hiện

- Rút gọn `backend/main.py`: dùng chung schema, metadata và cấu trúc kết quả; đồng bộ `category_merge_policy` với module gộp nhãn.
- API giới hạn body thực nhận ở 1 MiB, thời gian nhận body 30 giây, tối đa 32 POST đồng thời (trong đó tối đa 4 yêu cầu suy luận đang xử lý/chờ), 120 POST/phút/IP. Health vẫn có thể được phục vụ khi model bận. Trả `503 server_busy` hoặc `429 rate_limit_exceeded` kèm `Retry-After`.
- Chặn POST từ website thông thường. Có thể giới hạn Chrome extension bằng `ABSA_EXTENSION_IDS`. Khi không cấu hình, mọi Chrome extension có ID hợp lệ đều được chấp nhận. Request không có Origin vẫn được phép để vận hành qua CLI.
- Lỗi nội bộ và đường dẫn Java không còn xuất hiện trong response thông thường. Chi tiết lỗi model được ghi ở log server.
- Từ chối text đơn rỗng/toàn khoảng trắng/chứa NUL. Giới hạn độ dài các trường log.
- Văn bản vượt cửa sổ 384 token của model trả lỗi `text_exceeds_model_context`; không còn âm thầm bỏ qua category và báo kết quả rỗng thành công. Giới hạn này tính cả truy vấn category và token đặc biệt; không tương đương 384 từ hay 3000 ký tự.
- Kiểm tra hash/checkpoint/tokenizer dùng điều kiện chạy thật, không bị bỏ qua khi Python bật `-O`.
- Sửa ghi log khi ổ đĩa đầy: API báo thất bại để extension giữ sự kiện cho lần gửi lại.
- Ghép kết quả ưu tiên ID bình luận, tránh lệch kết quả khi nhiều bình luận trùng nội dung và một bình luận bị loại. Hiển thị các bình luận chưa có kết quả.
- Thêm timeout cho health và từng batch (5 giây / 10 phút). Hủy ở client không dừng phép suy luận đã chạy trên server.
- Rút gọn analytics, xóa `summarizeABSA` và các hàm xuất CSV không còn được UI sử dụng; dùng chung hàm đọc số Shopee; không tạo thêm preview chứa nội dung bình luận trên mỗi trang.
- Bỏ quyền `tabs` và `activeTab`: host permissions Shopee vẫn cho phép đọc URL sản phẩm và chạy collector; đã bỏ tính năng nhập riêng hoặc lấy văn bản được chọn để phân tích. Gói ZIP chỉ lấy tài nguyên extension theo loại file cho phép, kiểm tra hostname HTTPS và loại đường dẫn symlink. Không nhúng khóa API hay SSH.
- Docker dùng một worker, giữ cổng host tại localhost, bỏ Linux capabilities, cấm nâng quyền, bỏ bộ công cụ biên dịch sau khi cài và bổ sung protobuf. Các phiên bản API đã kiểm thử được ghim trong constraints.

## Kiểm chứng

Kết quả tại workspace: **65 kiểm thử Python và 53 kiểm thử extension đạt**, kiểm tra lỗi Python bằng Ruff và cú pháp JavaScript đạt, Compose ghép Oracle/AWS hợp lệ. Hash ba checkpoint NB20/NB39/NB46 khớp các giá trị đã ghi trong README/policy; các file VnCoreNLP cần thiết có mặt.

Chạy từ gốc dự án, trong môi trường Python riêng nếu `.venv` cũ bị lỗi:

```powershell
py -3.12 -m venv .test-venv
.\.test-venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.test-venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/extension_*.test.mjs
.\.test-venv\Scripts\ruff.exe check backend deploy tests --select E9,F63,F7,F82,F401
docker compose -f deploy/oracle/compose.yaml -f deploy/aws/compose.override.yaml config --quiet
```

Bộ kiểm thử gồm HTTP FastAPI/Pydantic thật, kiểm thử hồi quy thuật toán với model giả lập, thu thập DOM giả lập, chuyển sản phẩm, hủy tác vụ, cache và đóng gói ZIP. Các phép thử này không đo chất lượng AI hoặc hiệu năng checkpoint thực trên EC2.

## Trước khi phát hành

1. Làm theo `deploy/aws/README.md`: chuyển đúng checkpoint, VnCoreNLP, cấu hình DNS/HTTPS và chỉ mở 80/443; SSH giới hạn theo IP quản trị. Không mở 8000.
2. Đặt `ABSA_EXTENSION_IDS` trong `deploy/aws/.env` bằng ID thật, phân cách bằng dấu cách nếu có nhiều bản; tạo lại container API sau khi sửa. Không dùng khóa bí mật được nhúng trong extension làm cơ chế xác thực.
3. Chạy `/health` và dự đoán bằng model thật trên EC2, theo dõi RAM/OOM và thử nhiều client đồng thời. Gói hiện tại dùng API 6 GiB trên VM 8 GiB; cần đo để biết đủ RAM hay không.
4. Đối chiếu kết quả trước/sau và benchmark trên máy chủ nếu muốn tăng encoder batch. Không chuyển profile từ Windows sang EC2.
5. Tạo ZIP bằng hostname thật: `python -m deploy.oracle.package_extension --api-url https://TEN_MIEN_CUA_BAN --output dist/extension-aws.zip`. Giải nén và Load unpacked trên Chrome 120+; thử Shopee thật, nhiều trang bình luận, lỗi mạng, hủy và chuyển sản phẩm.
6. Chuẩn bị icon/ảnh store, thông tin hỗ trợ, chính sách quyền riêng tư và công bố việc gửi nội dung bình luận đến API AWS. Hiện chưa có đủ thông tin chủ sở hữu/tên miền để hoàn thiện hồ sơ store.

Giới hạn Origin và rate limit cục bộ không phải xác thực người dùng hay chống DDoS. Client ngoài trình duyệt có thể giả Origin. Nếu cần tài khoản/quota hoặc nhiều instance, phải bổ sung xác thực phía server và giới hạn tải dùng chung. Caddy là proxy được tin cậy trong mạng Docker; giữ API port bind localhost và không cho container không tin cậy tham gia mạng này.

Chưa xác nhận chạy end-to-end bằng Chrome/Shopee thật, chưa build/chạy Docker trên EC2, chưa kiểm thử tải hoặc đối chiếu model thật trên Linux. Không thể kết luận hệ thống hoàn toàn không còn lỗi chỉ từ kiểm thử tự động.

Các notebook, báo cáo nghiên cứu, checkpoint và VnCoreNLP không bị xóa khỏi máy. Notebook, `.venv`, log và dữ liệu không thuộc gói code đưa lên server. Checkpoint và wordsegmenter được chuyển riêng theo hướng dẫn AWS.

Nguồn đối chiếu: [Starlette middleware](https://www.starlette.io/middleware/), [FastAPI workers](https://fastapi.tiangolo.com/deployment/server-workers/), [Chrome manifest](https://developer.chrome.com/docs/extensions/reference/manifest).
