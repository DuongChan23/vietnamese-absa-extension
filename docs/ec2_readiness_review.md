# Rà soát trước khi đưa lên EC2 — 13/11/2026

Code đủ để chuyển sang bước triển khai thử trên EC2 2 vCPU/8 GiB. Chưa thể
kết luận đã tối ưu hết hoặc đủ RAM khi chưa build/chạy container trên máy đó.

## Những tối ưu đã có

- Model và JVM nạp một lần; Docker chạy một Uvicorn worker.
- Encoder hỗ trợ batching FP32, gom truy vấn theo chiều dài, giữ attention
  mask và loại padding trước khi giải mã. Khi OOM do batch, chia nhỏ batch.
- Dùng lại cảm xúc cho cùng span trong một bình luận; cache văn bản trùng
  trong mỗi request, giữ ID, thứ tự và số sao riêng của từng bình luận.
- Khóa suy luận dùng chung để tránh nhiều request cùng chạy model. API
  giới hạn số yêu cầu chờ, kích thước body và tốc độ gọi; health/log không
  cần giữ khóa suy luận.
- Thu thập lời bình có nội dung, lấy thống kê sao từ Shopee; giữ sản phẩm
  đang phân tích cho đến khi người dùng chủ động đổi.
- Có log thời gian, xoay vòng log; model/VnCoreNLP mount riêng, không đưa
  vào image. AWS override giới hạn API ở 6 GiB và 2 CPU.

## Sửa trong lần rà soát này

1. `backend/inference.py`: dựng encoder bằng cấu hình rồi nạp toàn bộ
   checkpoint NB39 với `strict=True`. Bỏ tải/nạp bộ trọng số XLM-R gốc
   vốn bị ghi đè ngay sau đó. Vẫn cần cấu hình kiến trúc từ Hugging Face
   trong lần khởi động đầu nếu cache chưa có.
2. Nạp checkpoint NB39/NB46 bằng `torch.load(..., mmap=True,
   weights_only=True)` để ánh xạ file thay vì đọc sẵn toàn bộ storage
   checkpoint vào RAM. Không thay precision, threshold hay thuật toán.
3. `extension/popup.js`: khi phân tích dừng sớm hoặc có bình luận lỗi,
   nhãn tiến độ phản ánh tình trạng đó thay vì luôn báo hoàn thành.
4. Bổ sung lệnh benchmark batch an toàn trên EC2 ở hướng dẫn AWS, cập
   nhật mô tả tải cấu hình ở hướng dẫn Docker chung.

Cách dựng model từ cấu hình và nạp trọng số riêng được mô tả trong
[Hugging Face Auto classes](https://huggingface.co/docs/transformers/model_doc/auto).
Cơ chế ánh xạ checkpoint được mô tả trong
[hướng dẫn PyTorch](https://docs.pytorch.org/tutorials/recipes/recipes/module_load_state_dict_tips.html).

## Kiểm chứng thực tế tại workspace

- 65 kiểm thử Python đạt; 53 kiểm thử extension đạt.
- Ruff kiểm tra E9,F63,F7,F82,F401 đạt; cấu hình Compose Oracle + AWS hợp
  lệ; Bash wrapper qua kiểm tra cú pháp.
- Cài dependency kiểm thử theo `requirements-dev.txt` vì môi trường
  `.venv` thiếu HTTP client; không sửa dependency production vì lỗi này.
- Đối chiếu checkpoint thật trước/sau: 30 bình luận trong fixture,
  `unified`, `vicloabsa`, `visd4sa`, mỗi chế độ dùng batch 1 và 4.
  Cả 180 cặp kết quả khớp hoàn toàn, gồm raw/merged aspects, offset,
  sentiment và nguồn. Hai bản đều dùng SDPA.
- Nạp model: trước 11,50 giây; sau 10,45 giây, một lượt mỗi bản trên
  Windows. Không dùng số đo này để cam kết phần trăm tăng tốc trên EC2.
- Bản sau: unified batch 1 là 21,83 giây; batch 4 là 17,09 giây trên
  30 dòng fixture, có cache văn bản trùng. Đây là phép đo kiểm tra một
  lượt, không đại diện mọi độ dài bình luận hay hiệu năng EC2.

Snapshot và helper đo được giữ tại `logs/ec2_before.json`,
`logs/ec2_after.json`, `logs/ec2_review_snapshot.py` (không đưa vào Git
hay gói server). Kết quả khớp trên fixture là kiểm tra hồi quy, không
phải chứng minh chất lượng AI trên dữ liệu Shopee mới.

## Giới hạn còn lại và bước tiếp theo

- Extension vẫn gửi `source: unified`: mỗi bình luận truy vấn cả 15
  category của hai miền dữ liệu. Đây vừa là chi phí lớn vừa là nguyên
  nhân có thể xuất hiện nhãn không hợp loại sản phẩm. Chưa có bộ định
  tuyến category theo sản phẩm; thêm nó sẽ thay đổi tập dự đoán và cần
  đánh giá riêng, không phải tối ưu giữ nguyên đầu ra.
- PhoBERT cảm xúc vẫn suy luận từng span. Batching phần này là hướng
  tối ưu tiếp theo nhưng phải kiểm tra padding/tokenization và đối chiếu
  đầu ra; chưa triển khai trong lần rà soát này.
- Profile Windows không được copy lên EC2. Dùng tuần tự trước, đo batch
  1/2/4 và chỉ kích hoạt cấu hình nhanh hơn, khớp đầu ra trên chính EC2.
- Chưa chạy Docker image: Docker daemon local không hoạt động. Chưa có
  kiểm thử Linux, đo đỉnh RAM, tải nhiều người hoặc Shopee thật.
- Trên EC2 cần xác nhận build thành công, `/health` ready, dự đoán thật,
  RAM/OOM, HTTPS và extension từ máy khác. Một worker giúp tiết kiệm
  RAM nhưng người dùng đồng thời vẫn phải chờ model.

Làm theo [hướng dẫn AWS](../deploy/aws/README.md); xem thêm
[rà soát phát hành công khai](production_review.md).
