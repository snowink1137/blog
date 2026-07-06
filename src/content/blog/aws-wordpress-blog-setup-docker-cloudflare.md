---
title: 'AWS에 WordPress 블로그 구축하기(feat. docker, cloudflare)'
description: 'AWS EC2에 Docker Compose로 WordPress를 올리고 Cloudflare로 도메인·HTTPS까지 연결하는 전 과정. SSH 설정, Security Group, Elastic IP 등 처음 서버를 만드는 사람 기준으로 정리했다.'
pubDate: '2025-12-06'
updatedDate: '2026-01-18'
category: tech
subcategory: 'AWS'
tags: ['aws', 'cloudflare', 'docker', 'wordpress']
---


## AWS EC2와 Docker Compose로 WordPress 블로그 구축하기

개인 블로그를 시작하려고 할 때 가장 먼저 고민되는 것이 호스팅입니다. 티스토리나 네이버 블로그 같은 플랫폼을 사용할 수도 있지만, 저는 AWS 사용법도 익힐 겸 직접 서버를 구축해봤습니다. 이 글에서는 AWS EC2 인스턴스에 Docker Compose를 활용하여 WordPress를 설치하는 방법을 다룹니다.

### 사전 준비

-   AWS 계정
-   EC2 인스턴스 (저는 t3.micro Ubuntu 이미지를 사용했습니다)
-   SSH 접속을 위한 PEM 키 파일

### SSH 설정하기

EC2 인스턴스에 접속하려면 PEM 키 파일이 필요합니다. 매번 `-i` 옵션으로 키 파일을 지정하는 것은 번거로우니, SSH config를 설정해두면 편리합니다. 처음 인스턴스를 만들 때 다운로드 받으라는 내용이 있어서 아마 저장해놓으셨을 겁니다.

```bash
# PEM 파일을 .ssh 디렉토리로 이동
mkdir -p ~/.ssh
mv ~/Downloads/your-key.pem ~/.ssh/
chmod 400 ~/.ssh/your-key.pem

# SSH config 설정
vim ~/.ssh/config
```

config 파일에 아래 내용을 추가합니다. 들여쓰기도 해줘야 합니다.

```text
Host wordpress
    HostName <EC2-퍼블릭-IP>  # 나중에 Elastic IP를 사용해서 IP가 고정되면 해당 IP로 변경해주세요.
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
```

이제 간단하게 `ssh wordpress` 명령어로 접속할 수 있습니다.

### Docker 설치

Ubuntu 기본 저장소의 docker 패키지는 버전이 오래되었으므로, Docker [공식 문서 방식대로](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository) 설치합니다.

```bash
# 필요한 패키지 설치
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Docker GPG 키 추가
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Docker 저장소 추가
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Docker 설치
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# sudo 없이 docker 사용하려면
sudo usermod -aG docker $USER
```

마지막 명령어 실행 후 재접속해야 적용됩니다.

### Docker Compose로 WordPress 구성

프로젝트 디렉토리를 만들고 docker-compose.yml 파일을 작성합니다.

```bash
mkdir ~/wordpress && cd ~/wordpress
vim docker-compose.yml
```

기본적인 wordpress php apache 이미지를 사용했고, DB도 같은 인스턴스에서 띄우는 것으로 설정했습니다. 나중에 사용량이 많아지면 데이터를 AWS RDS 같은 곳으로 마이그레이션할 생각입니다. 그런데 t3.small 인스턴스(vCPU 2, 1GB memory)를 사용하다보니 실행 중 OOM이 나기도 했습니다. 그래서 DB command로 여러 최적화 옵션을 추가했습니다.

```yaml
services:
  wordpress:
    image: wordpress:6.8.3-php8.3-apache
    restart: unless-stopped
    ports:
      - 80:80
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: exampleuser
      WORDPRESS_DB_PASSWORD: examplepass
      WORDPRESS_DB_NAME: exampledb
    volumes:
      - wordpress:/var/www/html

  db:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: exampledb
      MYSQL_USER: exampleuser
      MYSQL_PASSWORD: examplepass
      MYSQL_RANDOM_ROOT_PASSWORD: '1'
    volumes:
      - db:/var/lib/mysql
    command:
      - --innodb-buffer-pool-size=64M
      - --innodb-log-buffer-size=8M
      - --key-buffer-size=16M
      - --max-connections=20
      - --table-open-cache=64
      - --thread-cache-size=4
      - --performance-schema=OFF

volumes:
  wordpress:
  db:
```

컨테이너를 실행합니다.

```bash
docker compose -f wordpress-docker-compose.yaml -p wordpress up -d
```

### Security Group 설정

AWS 콘솔에서 EC2 인스턴스의 Security Group 인바운드 규칙에 HTTP(80) 포트를 추가해야 외부에서 접속할 수 있습니다.

| 유형 | 포트 | 소스 |
| --- | --- | --- |
| HTTP | 80 | 0.0.0.0/0 |

설정 후 브라우저에서 EC2 퍼블릭 IP로 접속하면 WordPress 설치 화면이 나타납니다. 해당 화면에서 WordPress 초기 설정을 해주시면 됩니다.

## Cloudflare로 도메인 등록하고 HTTPS 적용하기

위 내용에서 AWS EC2에 Docker로 WordPress를 설치했습니다. 하지만 IP 주소로 접속하는 것은 불편하고, HTTPS도 적용되어 있지 않습니다. 이번 글에서는 Cloudflare에서 도메인을 등록하고 무료로 HTTPS를 적용하는 방법을 알아봅니다.

### 도메인 등록 업체 비교

.com 도메인 기준으로 주요 업체들의 가격을 비교해보면 다음과 같습니다.

| 업체 | 연간 가격 | 특징 |
| --- | --- | --- |
| Cloudflare | ~$10.44 | 원가 판매, WHOIS 보호 무료 |
| AWS Route 53 | ~$12 + 호스팅 비용 | AWS 통합 편리 |
| 가비아 | ~24,000원 | 국내 1위, 한글 지원 |
| GoDaddy | 첫해 저렴, 갱신 시 비쌈 | 업셀 많음 |
| Namecheap | ~$9 (첫해) | UI 직관적 |

Cloudflare는 도메인을 원가에 판매하고, 갱신 가격도 동일합니다. 다른 업체들은 첫해만 저렴하고 2년차부터 가격이 오르는 경우가 많습니다. WHOIS 개인정보 보호와 DNSSEC도 무료로 제공됩니다. Cloudflare의 무료 플랜만으로도 CDN, DDoS 방어, SSL 인증서 등 다양한 기능을 사용할 수 있습니다.

### Cloudflare 도메인 등록

1.  [cloudflare.com](https://cloudflare.com) 접속 후 계정 생성
2.  좌측 메뉴 **Domain Registration** → **Register Domains**
3.  원하는 도메인 검색 후 **Purchase**
4.  소유자 정보 입력 (영문) 및 결제

WHOIS 개인정보 보호는 자동으로 적용되어 별도 설정이 필요 없습니다.

### Elastic IP 설정

구매한 도메인에 IP를 연결해야하는데요. 그 전에 Elastic IP를 설정하면 좋습니다. EC2 인스턴스를 중지했다가 다시 시작하면 퍼블릭 IP가 바뀔 수 있기 때문입니다. Elastic IP를 할당하면 IP가 고정됩니다. 위 내용에 있었던 .ssh config 파일에서도 Elastic IP를 사용하도록 변경이 필요합니다.

1.  AWS 콘솔 → EC2 → **탄력적 IP**
2.  **탄력적 IP 주소 할당** 클릭
3.  생성된 IP 선택 → **작업** → **탄력적 IP 주소 연결**
4.  인스턴스 선택 후 연결

Elastic IP는 EC2에 연결된 상태에서는 무료입니다.

### DNS 설정

도메인 등록 후 DNS 메뉴에서 A 레코드를 추가합니다.

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | @ | EC2 IP 주소 | On |
| A | www | EC2 IP 주소 | On |

Proxy를 On(주황색 구름)으로 설정하면 Cloudflare가 중간에서 트래픽을 처리합니다.

### HTTPS 적용 (Cloudflare Proxy)

Cloudflare Proxy를 사용하면 Let’s Encrypt 같은 별도 인증서 설정 없이 HTTPS를 적용할 수 있습니다.

```text
[클라이언트] ←── HTTPS ──→ [Cloudflare] ←── HTTP ──→ [EC2]
```

**SSL/TLS** 메뉴에서 모드를 선택합니다.

| 모드 | 설명 |
| --- | --- |
| Flexible | 클라이언트↔Cloudflare만 HTTPS |
| Full | 양쪽 HTTPS, 인증서 검증 안 함 |
| Full (Strict) | 양쪽 HTTPS, 인증서 검증 |

개인 블로그라면 **Flexible**로 시작해도 충분합니다. 보안이 더 중요하다면 EC2에 Let’s Encrypt를 설치하고 Nginx를 띄워서 **Full** (Strict) 를 사용하면 됩니다. 저는 아직 더 큰 인스턴스를 사용할 생각이 없어서 Flexible로 해두었습니다.

## 마무리

이제 기본적인 AWS EC2, Cloudflare로 구매한 도메인을 사용한 WordPress 블로그가 구축되었습니다. SaaS로 제공되는 다른 WordPress에 비해 약간 노력이 더 들어가긴 했지만 좀더 자유도 높은 환경을 만들었다고 생각합니다. 트래픽이 많아지면 EC2의 인스턴스 유형을 바꾸고 RDS 같은 외부 DB를 사용하는 것도 좋을 것 같습니다.
