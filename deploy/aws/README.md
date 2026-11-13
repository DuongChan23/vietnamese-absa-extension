# Đưa ABSA lên AWS EC2 bằng tài khoản có credit

Trước khi phát hành cho người dùng thật, đọc [kết quả rà soát và giới hạn kiểm chứng](../../docs/production_review.md).

Cập nhật: 12/11/2026. Mục tiêu: một EC2 Ubuntu chạy FastAPI + model CPU + Java,
Caddy cung cấp HTTPS, extension gọi API đó. Chưa cần load balancer, RDS, NAT
Gateway, Kubernetes hoặc GPU cho bản chạy thử này.

## 1. Kiểm tra credit trước khi tạo máy

Trong AWS Console, xem số dư credit, ngày hết hạn và account plan tại **Billing
and Cost Management** hoặc **Settings Portal**, tùy giao diện tài khoản.
100 USD là tín dụng thanh toán cho mức sử dụng hợp lệ, không phải một máy
8 GB được miễn phí vĩnh viễn. Không cần nâng cấp Paid plan chỉ để làm theo
hướng dẫn nếu Free plan của bạn đã cho phép chọn máy dưới đây.

Theo dõi số dư credit trực tiếp. Có thể thêm email cảnh báo chi phí bằng AWS
Budgets, nhưng cảnh báo không phải giới hạn cứng và có độ trễ. Chi phí sau
credit có thể khác chi phí sử dụng trước credit; một báo cáo tiền ròng thấp
không có nghĩa chưa tiêu credit.

Nguồn: [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/),
[AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).

## 2. Tạo EC2 Ubuntu

1. Chọn region, ví dụ **Asia Pacific (Singapore), ap-southeast-1** nếu region
   đó có trong tài khoản. Giữ nguyên region này khi tìm instance sau này.
2. Mở **EC2 → Instances → Launch instances**.
3. Điền cấu hình:

| Mục | Chọn |
|---|---|
| Name | `vietnamese-absa` |
| AMI | Ubuntu Server 24.04 LTS, **64-bit x86**, publisher Canonical; không dùng AMI Marketplace có phụ phí |
| Instance type | **m7i-flex.large**, 2 vCPU / 8 GiB RAM |
| Number of instances | **1** |
| Key pair | Create new: `absa-ec2`, RSA, định dạng **.pem**; tải về máy |
| Network | Default VPC có public subnet và đường ra Internet Gateway |
| Auto-assign public IP | Enable |
| Root storage | **50 GiB gp3**, giữ thông số hiệu năng mặc định |
| Purchase option | On-Demand; không tạo thêm instance/Spot Fleet |

Đối chiếu giá và điều kiện credit trên màn hình xác nhận rồi mới Launch.
Nếu m7i-flex.large không có/không được phép trong region hoặc plan hiện tại,
chưa thay bằng một máy khác có phí mà chưa kiểm tra điều kiện. Máy micro
1–2 GB RAM không phù hợp để bê nguyên bộ model này lên.

AWS hiện liệt kê m7i-flex.large trong các loại máy hỗ trợ Free plan mới;
việc sử dụng vẫn tiêu credit, và thời gian còn dùng được phụ thuộc số dư.
[Tài liệu EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/LaunchingAndUsingInstances.html),
[thông số máy](https://aws.amazon.com/ec2/instance-types/general-purpose/).

Trong **Security Group**, cấu hình inbound:

| Loại | Port | Source |
|---|---:|---|
| SSH | 22 | **My IP**, tức IP hiện tại của bạn `/32` |
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` |

Không mở 8000 ra Internet. Giữ outbound mặc định để cài package, tải base
model và cấp chứng chỉ. Sau Launch, đợi **Running**, kiểm tra status checks
đều đạt rồi ghi lại **Public IPv4 address**.

Key `.pem` dùng trên máy bạn để SSH, không upload vào EC2, Git hoặc extension.
[Tham số tạo instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-launch-parameters.html).

## 3. SSH từ Windows

Mở **hai cửa sổ PowerShell**. Một cửa sổ sẽ SSH vào Ubuntu, cửa sổ còn lại
giữ tại thư mục project để nén/upload file. Thay đường dẫn key và IP thật:

```powershell
$Ec2Key = 'C:\Users\admin\Downloads\absa-ec2.pem'
$Ec2Ip = 'PUBLIC_IP_CUA_EC2'
ssh -i $Ec2Key "ubuntu@$Ec2Ip"
```

Username cho image Ubuntu là `ubuntu`. Xác nhận host key khi kết nối lần đầu
sau khi đối chiếu thông tin instance. Trong cửa sổ đã SSH vào **Ubuntu**:

```bash
uname -m
free -h
df -h /
mkdir -p ~/absa/models ~/absa/vncorenlp ~/absa/logs
```

Kỳ vọng `x86_64`, RAM gần 8 GiB, ổ đĩa gần 50 GiB. Nếu SSH timeout, kiểm tra
đúng IP/region, instance đang Running và SSH rule đúng IP Internet hiện tại.

## 4. Cài Docker trên EC2

Chạy trong **Ubuntu qua SSH**, theo repository Docker chính thức:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

[Hướng dẫn Docker](https://docs.docker.com/engine/install/ubuntu/).
Python/JDK/thư viện ML sẽ được cài bên trong image; không phải cài lại từng
thư viện Python lên host Ubuntu.

## 5. Nén và chuyển code/model

Quay lại cửa sổ **PowerShell Windows** chưa SSH, tại gốc project:

```powershell
Set-Location 'C:\Users\admin\Desktop\vietnamese-absa-extension'
$Ec2Key = 'C:\Users\admin\Downloads\absa-ec2.pem'
$Ec2Ip = 'PUBLIC_IP_CUA_EC2'
New-Item -ItemType Directory -Force dist | Out-Null
tar -czf dist/absa-code.tar.gz --exclude='__pycache__' --exclude='*.pyc' --exclude='.env' --exclude='*/.env' backend deploy .dockerignore tests/fixtures
tar -czf dist/absa-models.tar.gz models/ate_category_conditioned_v1 models/absa_joint_biaffine_span_pair_v1 models/absa_joint46_boundary_ranking_pilot_v1 models/phobert_asc_training
tar -czf dist/absa-vncorenlp.tar.gz -C vncorenlp VnCoreNLP-1.2.jar models/wordsegmenter
scp -i $Ec2Key dist/absa-code.tar.gz dist/absa-models.tar.gz dist/absa-vncorenlp.tar.gz "ubuntu@${Ec2Ip}:~/absa/"
```

Các archive có dung lượng vài GB, chờ từng lệnh xong. Cách này bao gồm code
đã sửa trong workspace dù chưa commit. Chỉ clone Git sẽ thiếu model và Java
data vì chúng đang được gitignore. Không upload `.venv` Windows lên Linux.

Quay lại **Ubuntu SSH**:

```bash
cd ~/absa
tar -xzf absa-code.tar.gz
tar -xzf absa-models.tar.gz
tar -xzf absa-vncorenlp.tar.gz -C vncorenlp
ls models/absa_joint_biaffine_span_pair_v1/joint_best.pt
ls vncorenlp/VnCoreNLP-1.2.jar vncorenlp/models/wordsegmenter/wordsegmenter.rdr
sudo bash deploy/aws/compose.sh config --quiet
sudo bash deploy/aws/compose.sh up -d --build api
sudo bash deploy/aws/compose.sh logs -f api
```

`compose.sh` tái sử dụng image/HTTPS stack trong `deploy/oracle`, áp dụng
override AWS **6 GiB RAM, 2 CPU** cho API và project name riêng `absa-aws`.
Không chạy Compose Oracle một mình trên máy 8 GiB vì cấu hình gốc đặt 10 GiB.

Chỉ một worker nạp model. Checkpoint/Java data được mount chỉ đọc, cache
Hugging Face và log được giữ ngoài image. Lần đầu tải/cài có thể mất nhiều
phút, không có mốc thời gian cố định. `Ctrl+C` thoát xem log, không dừng server.

## 6. Kiểm tra backend trước khi bật HTTPS

Trong **Ubuntu SSH**:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:8000/predict \
  -H 'Content-Type: application/json' \
  -d '{"source":"unified","text":"Áo đẹp nhưng vải mỏng."}'
```

Phải thấy `ready: true` và dự đoán thành công. Có `Uvicorn running` chưa đủ
nếu model báo startup error. Backend mặc định dùng batch 1 ở môi trường chưa
benchmark; không copy profile Windows sang server.

Nếu container dừng hoặc không healthy:

```bash
sudo bash deploy/aws/compose.sh ps -a
sudo bash deploy/aws/compose.sh logs --tail 100 api
sudo docker inspect --format '{{.State.OOMKilled}}' "$(sudo bash deploy/aws/compose.sh ps -a -q api)"
free -h
df -h /
```

Nếu OOMKilled=true, dừng tại đây để đo đỉnh RAM/điều chỉnh. Không bật nhiều
worker hoặc tự nâng máy lên cấu hình đắt hơn trước khi kiểm tra credit. Mức
8 GiB là cấu hình thử ban đầu, chưa được xác nhận bằng chạy thực tế dự án này.
Lỗi thiếu file/hash phải sửa file đầu vào đúng, không bỏ assertion để chạy.

Không benchmark bằng một process model thứ hai khi API đang nạp model trên
máy 8 GiB. Chỉ tối ưu batch sau khi luồng tuần tự đã hoạt động ổn định.

### Đo và chọn batch trên chính EC2

Thực hiện trước khi có người sử dụng. Dừng API để tránh giữ hai bản model
trong RAM, chạy benchmark rồi khởi động lại API:

```bash
sudo bash deploy/aws/compose.sh stop api
sudo bash deploy/aws/compose.sh run --rm --no-deps api \
  python -m backend.benchmark_inference tests/fixtures/inference_batching_reviews.json \
  --limit 30 --repeats 2 --batch-sizes 1 2 4 --activate
sudo bash deploy/aws/compose.sh up -d api
curl -fsS http://127.0.0.1:8000/health
```

Đọc `logs/inference_benchmark.json`. Công cụ chỉ chọn batch có đầu ra khớp
chế độ tuần tự và nhanh hơn ít nhất 5% trên dữ liệu thử. Đây là đối chiếu
hồi quy trên bộ thử, không chứng minh độ chính xác trên mọi bình luận.
Theo dõi RAM bằng `docker stats` ở cửa sổ SSH khác khi đo. Nếu benchmark
thất bại hoặc bị OOM, vẫn khởi động lại API bằng lệnh `up -d api`; không
ép batch lớn bằng biến môi trường. Không dùng profile benchmark từ Windows.

## 7. Tên miền và HTTPS

Cần một hostname do bạn kiểm soát DNS. Có thể dùng tên miền của nhóm/trường
hoặc một subdomain DNS miễn phí nếu bạn có. Tạo bản ghi A trỏ tới Public IP
EC2. Không tạo AAAA khi chưa cấu hình IPv6.

Trong **Ubuntu SSH**:

```bash
cd ~/absa
cp deploy/aws/.env.example deploy/aws/.env
nano deploy/aws/.env
```

Điền hostname thật, không có `https://` hoặc đường dẫn, và email thật:

```dotenv
ABSA_DOMAIN=absa.ten-mien-cua-ban.com
ACME_EMAIL=email-cua-ban@example.com
ABSA_EXTENSION_IDS=ID_EXTENSION_THAT_CUA_BAN
```

Sau khi DNS trỏ đúng và security group đã mở 80/443:

`ABSA_EXTENSION_IDS` nhận ID 32 ký tự a–p từ `chrome://extensions` hoặc Chrome Web Store;
nhiều ID phân cách bằng dấu cách. Khi thử bản unpacked chưa có ID cố định, có thể để
trống; phải điền ID thật cho bản phát hành. Đây là giới hạn Origin, không phải xác thực.

```bash
sudo bash deploy/aws/compose.sh --profile https up -d
sudo bash deploy/aws/compose.sh --profile https logs -f caddy
```

Wrapper tự đọc `deploy/aws/.env`. Caddy cấp/gia hạn chứng chỉ và chuyển HTTP
sang HTTPS. Không cần thêm load balancer hoặc mua chứng chỉ.
[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https).

Từ **PowerShell Windows**, thay hostname thật:

```powershell
Invoke-RestMethod https://TEN_MIEN_CUA_BAN/health
```

Phải có `ready: true`, trình duyệt không báo lỗi chứng chỉ. Nếu chưa có tên
miền, vẫn có thể thử riêng API bằng SSH tunnel mà không mở port 8000:

```powershell
ssh -i $Ec2Key -L 18000:127.0.0.1:8000 "ubuntu@$Ec2Ip"
```

Giữ cửa sổ tunnel mở, rồi từ cửa sổ PowerShell khác:

```powershell
Invoke-RestMethod http://127.0.0.1:18000/health
```

Tunnel chỉ dành cho kiểm tra trên máy bạn; chưa thay thế HTTPS công khai cho
mọi người cài extension.

## 8. Tạo extension dùng API AWS

Ở gốc project trên **Windows**:

```powershell
.\.venv\Scripts\python.exe -m deploy.oracle.package_extension --api-url https://TEN_MIEN_CUA_BAN --output dist/extension-aws.zip
```

Dùng lại công cụ đóng gói chung: file ZIP trỏ API sang AWS và có host permission
cho hostname đó; source extension localhost không bị đổi. Gói không chứa
checkpoint hay SSH key. Giải nén ZIP vào thư mục riêng, Load unpacked và thử
từ máy khác trước khi phát hành lên store.

## 9. Dừng khi không demo và quản lý chi phí

Trong EC2 Console: chọn đúng instance → **Instance state → Stop instance**.
Không dùng Terminate để tạm nghỉ vì nó có thể xóa root volume theo cấu hình.
Chỉ dừng container vẫn để EC2 chạy và tiêu credit.

EC2 stopped không bị tính tiền compute, nhưng **EBS vẫn có chi phí**. Public
IPv4/Elastic IP và các tài nguyên khác có quy tắc tính phí riêng. Public IPv4
tự cấp thường đổi sau Stop/Start; khi bật lại, cập nhật `$Ec2Ip` và DNS. Nếu
cần IP cố định để phát hành lâu dài, cân nhắc Elastic IP sau khi xem giá.

Nguồn: [Stop/Start EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html),
[EC2 billing FAQ](https://aws.amazon.com/ec2/faqs/),
[Public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

## 10. Trạng thái và phạm vi kiểm tra

Cấu hình ghép Compose đã kiểm tra cấu trúc, wrapper Bash đã kiểm tra cú pháp.
Chưa tạo tài nguyên AWS hoặc build/chạy container trên EC2 trong quá trình
chuẩn bị này. Các bước 5–6 là phần kiểm chứng thực tế sau khi bạn tạo máy.

Docker dùng PyTorch CPU 2.10.0/Transformers 4.57.6, có thể khác môi trường
Windows hiện tại; cần đối chiếu đầu ra trước khi khẳng định kết quả giống
tuyệt đối. Bộ triển khai không thay checkpoint hay tự thêm nhãn ngành hàng.
