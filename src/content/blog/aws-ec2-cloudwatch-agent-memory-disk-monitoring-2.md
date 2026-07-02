---
title: 'AWS EC2 모니터링 가이드 (2) – CloudWatch Agent로 메모리/디스크 모니터링하기'
description: '메모리 사용률은 어디서 볼 수 있을까? 모니터링 가이드 Part 1에서 EC2 기본 모니터링과 CloudWatch 알람을 설정했습니다. 그런데 막상 서버를 운영하다 보면 가장 궁금한 건 따로 있습니다. “메모리가 얼마나 남았지? 디스크가 꽉 차면 어떡하지?” t3.micro처럼 메모리가 1GB뿐인 인스턴스에서 WordPress와 MySQL을 Docker로 돌리고 있다면, 메모리 부족은 현실적인 걱정입니다. 하지만 EC2 기본 모니터링에서는 메모리 사용률과 디스크 용량을 제공하지 …'
pubDate: '2026-01-06'
updatedDate: '2026-02-19'
category: tech
tags: ['aws', 'cloud-watch', 'cloud-watch-agent', 'ec2', 'monitoring']
---

## 메모리 사용률은 어디서 볼 수 있을까?

[모니터링 가이드 Part 1](/aws-ec2-monitoring-cloudwatch-guide-1/)에서 EC2 기본 모니터링과 CloudWatch 알람을 설정했습니다. 그런데 막상 서버를 운영하다 보면 가장 궁금한 건 따로 있습니다.

“메모리가 얼마나 남았지? 디스크가 꽉 차면 어떡하지?”

t3.micro처럼 메모리가 1GB뿐인 인스턴스에서 WordPress와 MySQL을 Docker로 돌리고 있다면, 메모리 부족은 현실적인 걱정입니다. 하지만 EC2 기본 모니터링에서는 **메모리 사용률과 디스크 용량을 제공하지 않습니다.**

이번 글에서는 **CloudWatch Agent**를 설치해서 메모리, 디스크 용량, swap 메모리까지 모니터링하는 방법을 다룹니다.

## CloudWatch Agent란?

CloudWatch Agent는 **EC2 인스턴스 내부에 설치하는 프로그램**입니다. OS 레벨에서 시스템 정보를 수집해 CloudWatch로 전송합니다.

### 기본 모니터링 vs CloudWatch Agent

| 구분 | 기본 모니터링 | CloudWatch Agent |
| --- | --- | --- |
| **설치** | 필요 없음 (자동) | 직접 설치 필요 |
| **수집 위치** | 하이퍼바이저 (AWS 인프라) | OS 내부 |
| **메모리 사용률** | ❌ | ✅ |
| **디스크 용량** | ❌ | ✅ |
| **swap 메모리** | ❌ | ✅ |
| **프로세스 모니터링** | ❌ | ✅ |
| **로그 수집** | ❌ | ✅ |

기본 모니터링은 AWS 인프라 레벨에서 데이터를 수집하기 때문에 OS 내부 정보를 알 수 없습니다. CloudWatch Agent는 인스턴스 안에서 직접 `/proc/meminfo`, `/proc/diskstats` 같은 시스템 정보를 읽어서 CloudWatch로 보냅니다.

## t3.micro에서 Agent 리소스 사용량

“Agent 설치하면 서버가 더 느려지는 거 아니야?”

t3.micro (vCPU 2개, 메모리 1GB)처럼 작은 인스턴스를 사용한다면 당연히 걱정될 수 있습니다. 실제 리소스 사용량을 정리하면 다음과 같습니다.

| 설정 | CPU 사용량 | 메모리 사용량 |
| --- | --- | --- |
| 메트릭만 수집 | 1-5% | 약 50-100MB |
| 로그 수집 추가 (절대 경로) | 5-10% | 약 100-150MB |
| 로그 수집 + 와일드카드 (`**/*.log`) | 15-40%+ | 200MB+ ⚠️ |

**메트릭 수집만 한다면 t3.micro에서도 충분히 돌아갑니다.** 이 글에서 다루는 메모리/디스크/CPU/swap 메트릭 수집은 가벼운 작업입니다.

> **💡 리소스 사용량을 줄이는 팁**
> 
> -   `metrics_collection_interval`을 60초 이상으로 설정 (기본값 60초)
> -   로그 수집 시 와일드카드(`*`) 대신 **절대 경로** 사용
> -   필요한 메트릭만 선택적으로 수집

### Agent 리소스 사용량 직접 확인하기

Agent 설치 후 실제로 얼마나 리소스를 사용하는지 확인할 수 있습니다.

```xml
<em># 방법 1: ps 명령어로 확인</em>
ps aux | grep amazon-cloudwatch-agent | grep -v grep

<em># 방법 2: top에서 실시간 확인 (q로 종료)</em>
top -p $(pgrep -d',' amazon-cloudwatch)

<em># 방법 3: htop 설치 후 확인 (더 보기 편함)</em>
sudo apt install htop -y
htop
```

> **💡 pgrep 옵션 설명**
> 
> -   `-f`: 리눅스는 프로세스 이름을 15자까지만 저장합니다. `amazon-cloudwatch-agent`는 15자를 초과하므로 `-f` 옵션으로 전체 명령행에서 검색해야 합니다.
> -   `-d','`: 여러 PID를 쉼표로 구분해서 출력합니다. `top -p`는 PID를 쉼표로 구분해서 받기 때문에 필요합니다. (예: `1234,5678`)

`htop`에서 `F4`를 눌러 `cloudwatch`로 필터링하면 Agent 프로세스만 볼 수 있습니다.

> **💡 맥 사용자**
> 
> 맥 기본 키보드에서는 F4가 시스템 기능(Launchpad 등)에 매핑되어 있어서 `fn + F4`를 눌러야 할 수 있습니다.

> **💡 프로세스가 여러 개로 보인다면?**
> 
> htop은 기본적으로 **스레드를 개별 행으로 표시**합니다. 여러 행이 보여도 RES(실제 메모리)와 MEM% 값이 동일하다면 같은 메모리를 공유하는 스레드들이에요. 실제 사용량은 한 번만 카운트됩니다. `H` 키를 누르면 스레드를 숨기고 프로세스 단위로만 볼 수 있습니다.

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-01-image-25.png)

## 사전 준비: IAM 역할 생성

CloudWatch Agent가 CloudWatch로 데이터를 보내려면 **권한**이 필요합니다. IAM 역할을 생성하고 EC2에 연결해야 합니다.

### 1단계: IAM 역할 생성

1.  AWS 콘솔에서 **IAM** 서비스로 이동
2.  좌측 메뉴에서 **역할(Roles)** 클릭
3.  **역할 생성** 버튼 클릭

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-02-image-17.png)

4.  **신뢰할 수 있는 엔터티 유형**: AWS 서비스 선택
5.  **사용 사례**: EC2 선택
6.  **다음** 클릭

### 2단계: 권한 정책 연결

1.  검색창에 `CloudWatchAgent` 입력
2.  **CloudWatchAgentServerPolicy** 체크박스 선택
3.  **다음** 클릭

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-03-image-18.png)

> **💡 CloudWatchAgentServerPolicy에 포함된 권한**
> 
> 이 정책은 CloudWatch에 메트릭/로그를 쓰고(`PutMetricData`, `PutLogEvents`), EC2 태그를 읽는(`DescribeTags`) 권한을 포함합니다. Agent 실행에 필요한 최소 권한입니다.

### 3단계: 역할 이름 지정 및 생성

1.  **역할 이름**: `EC2-CloudWatch-Agent-Role` (알아보기 쉬운 이름)
2.  **역할 생성** 클릭

### 4단계: EC2에 역할 연결

1.  **EC2** 서비스로 이동
2.  대상 인스턴스 선택
3.  **작업** > **보안** > **IAM 역할 수정** 클릭
4.  방금 생성한 역할 선택
5.  **IAM 역할 업데이트** 클릭

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-04-image-19.png)

역할이 연결되면 EC2 인스턴스 정보에서 **IAM 역할** 항목에 역할 이름이 표시됩니다.

## CloudWatch Agent 설치 (Ubuntu)

이제 EC2에 SSH로 접속해서 Agent를 설치합니다. Ubuntu 기준으로 설명합니다.

### Agent 패키지 다운로드 및 설치

```php
# 패키지 다운로드
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb

# 패키지 설치
sudo dpkg -i -E ./amazon-cloudwatch-agent.deb
```
![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-05-image-20.png)

설치가 완료되면 `/opt/aws/amazon-cloudwatch-agent/` 디렉토리에 Agent 파일들이 생성됩니다.

> **💡 다른 아키텍처/OS 사용 시**
> 
> ARM 기반 인스턴스(Graviton)를 사용한다면 `amd64` 대신 `arm64`로 변경하세요. 다른 OS의 다운로드 링크는 [AWS 공식 문서](https://docs.aws.amazon.com/ko_kr/AmazonCloudWatch/latest/monitoring/download-CloudWatch-Agent-on-EC2-Instance-commandline-first.html)에서 확인할 수 있습니다.

## 설정 파일 구성

Agent는 **설정 파일** (config.json) 을 읽어서 어떤 메트릭을 수집할지 결정합니다.

### 설정 방법 두 가지

**방법 1: 설정 마법사 사용** ([AWS 문서](https://docs.aws.amazon.com/ko_kr/AmazonCloudWatch/latest/monitoring/create-cloudwatch-agent-configuration-file-wizard.html))

```
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

CLI에서 대화형으로 질문에 답하면 설정 파일이 자동 생성됩니다. 웹 UI가 아니라 터미널에서 진행합니다. 편리하지만 옵션이 많아서 시간이 걸립니다.

**방법 2: config.json 직접 작성** ✅ (이 글에서 사용) ([AWS 문서](https://docs.aws.amazon.com/ko_kr/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html)) 필요한 설정만 직접 작성합니다. 복사해서 바로 사용할 수 있어 빠릅니다.

### config.json 작성

아래 명령어로 설정 파일을 생성합니다.

```
sudo vi /opt/aws/amazon-cloudwatch-agent/bin/config.json
```

다음 내용을 붙여넣습니다.

```json
{
  "agent": {
    "metrics_collection_interval": 60
  },
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "metrics_collected": {
      "mem": {
        "measurement": [
          "mem_used_percent",
          "mem_available_percent"
        ],
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": [
          "disk_used_percent",
          "disk_free"
        ],
        "metrics_collection_interval": 60,
        "resources": [
          "/"
        ]
      },
      "cpu": {
        "measurement": [
          "cpu_usage_active",
          "cpu_usage_idle"
        ],
        "metrics_collection_interval": 60,
        "totalcpu": true
      },
      "swap": {
        "measurement": [
          "swap_used_percent"
        ],
        "metrics_collection_interval": 60
      }
    }
  }
}
```

> **💡 run\_as\_user를 생략하면?**
> 
> `run_as_user`를 지정하지 않으면 CloudWatch Agent는 기본값인 **root 권한**으로 실행됩니다. root로 실행하면 `/var/log/syslog`, `/var/log/auth.log`, Docker 로그 등 대부분의 로그 파일을 별도 권한 설정 없이 읽을 수 있습니다. ([AWS 문서 참고](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html))

### 설정 항목 설명

| 항목 | 설명 |
| --- | --- |
| `metrics_collection_interval` | 메트릭 수집 주기 (초). 60초 권장 |
| `namespace` | CloudWatch에서 메트릭을 찾을 네임스페이스 |
| `append_dimensions` | 메트릭에 추가할 차원. InstanceId로 인스턴스 구분 |

### 수집하는 메트릭

| 카테고리 | 메트릭 | 설명 |
| --- | --- | --- |
| **mem** | `mem_used_percent` | 메모리 사용률 (%) |
| **mem** | `mem_available_percent` | 사용 가능한 메모리 비율 (%) |
| **disk** | `disk_used_percent` | 디스크 사용률 (%) |
| **disk** | `disk_free` | 남은 디스크 공간 (bytes) |
| **cpu** | `cpu_usage_active` | CPU 활성 사용률 (%) |
| **cpu** | `cpu_usage_idle` | CPU 유휴 비율 (%) |
| **swap** | `swap_used_percent` | swap 메모리 사용률 (%) |

> **💡 disk의 resources 설정**
> 
> `"resources": ["/"]`는 **루트 마운트 포인트의 디스크 용량**을 모니터링한다는 의미입니다. `/var`, `/home` 등 하위 디렉토리가 같은 볼륨에 있다면 당연히 포함됩니다. 이 설정은 파일을 탐색하는 게 아니라 `df -h` 명령어처럼 마운트 포인트 단위로 용량을 측정합니다.
> 
> 만약 EBS 볼륨을 추가로 연결해서 `/mnt/data`에 마운트했다면, `"resources": ["/", "/mnt/data"]`로 지정해야 해당 볼륨도 모니터링됩니다. `"resources": ["*"]`로 설정하면 모든 마운트 포인트를 수집하지만, 메트릭 개수가 늘어나 비용이 증가할 수 있습니다.

> **💡 totalcpu 설정**
> 
> `"totalcpu": true`는 전체 CPU 평균을 수집합니다. `false`로 설정하면 코어별로 따로 수집되어 메트릭 개수가 늘어납니다.

## Agent 시작 및 상태 확인

### Agent 시작

설정 파일을 적용하고 Agent를 시작합니다.

```javascript
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json \
  -s
```

각 옵션의 의미:

-   `-a fetch-config`: 설정 파일을 가져와서 적용
-   `-m ec2`: EC2 환경에서 실행
-   `-c file:경로`: 설정 파일 경로 지정
-   `-s`: 적용 후 Agent 시작

### Agent 상태 확인

```
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a status
```

정상적으로 실행 중이라면 다음과 같이 출력됩니다.

```json
{
  "status": "running",
  "starttime": "2024-01-15T10:30:00+0000",
  "configstatus": "configured",
  "cwoc_status": "stopped",
  "cwoc_configstatus": "not configured",
  "version": "1.300026.0"
}
```
![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-06-image-21.png)

`"status": "running"`이 표시되면 정상입니다.

> **💡 Agent 재시작/중지 명령어**
> 
> ```php
> # 재시작
> sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a restart
> 
> # 중지
> sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a stop
> ```

## CloudWatch에서 새 메트릭 확인하기

Agent가 정상 실행되면 1-2분 후 CloudWatch에서 메트릭을 확인할 수 있습니다.

### CWAgent 네임스페이스 찾기

1.  AWS 콘솔에서 **CloudWatch** 서비스로 이동
2.  좌측 메뉴에서 **지표(Metrics)** > **모든 지표** 클릭
3.  하단의 **사용자 지정 네임스페이스**에서 **CWAgent** 선택

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-07-image-22.png)

> **⚠️ CWAgent가 안 보인다면?**
> 
> -   Agent 시작 후 2-3분 정도 기다려보세요
> -   Agent 상태가 `running`인지 확인하세요
> -   IAM 역할이 EC2에 제대로 연결되었는지 확인하세요

### 메모리/디스크 메트릭 확인

**CWAgent** 네임스페이스를 클릭하면 여러 그룹이 보입니다. 메트릭 종류에 따라 다른 차원(dimensions)이 붙기 때문입니다.

| 차원 그룹 | 포함된 메트릭 |
| --- | --- |
| **InstanceId** | mem\_used\_percent, mem\_available\_percent, swap\_used\_percent |
| **InstanceId, cpu** | cpu\_usage\_active, cpu\_usage\_idle |
| **InstanceId, device, fstype, path** | disk\_used\_percent, disk\_free |

각 그룹을 클릭해서 원하는 메트릭을 체크하면 상단 그래프에서 확인할 수 있습니다.

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-08-image-23.png)

이제 드디어 EC2 콘솔에서 볼 수 없던 **메모리 사용률**과 **디스크 용량**을 CloudWatch에서 확인할 수 있습니다!

## 메모리 알람 만들기

[Part 1](/aws-ec2-monitoring-cloudwatch-guide-1/)에서 CPU 알람을 만든 것처럼, 메모리 알람도 설정해보겠습니다.

### mem\_used\_percent vs mem\_available\_percent

알람을 만들기 전에, 어떤 메트릭을 기준으로 할지 결정해야 합니다.

| 메트릭 | 의미 | buff/cache 처리 |
| --- | --- | --- |
| **mem\_used\_percent** | 현재 점유된 메모리 비율 | 포함 (해제 가능한 것도 “사용 중”으로 계산) |
| **mem\_available\_percent** | 지금 당장 쓸 수 있는 메모리 비율 | 제외 (필요 시 해제되므로 “가용”으로 계산) |

리눅스는 남는 메모리를 buff/cache로 활용합니다. 이 영역은 애플리케이션이 메모리를 요청하면 **자동으로 해제**됩니다. 그래서 `mem_used_percent`가 80%여도 실제로는 문제없는 경우가 많습니다.

**`mem_available_percent`가 낮아지면 “진짜 쓸 수 있는 메모리가 부족하다”는 의미**이므로, 실제 메모리 부족 상황을 더 정확하게 감지할 수 있습니다. 특히 t3.micro처럼 메모리가 작은 인스턴스에서는 이 메트릭이 더 현실적입니다.

### 알람 생성

1.  CloudWatch > **경보(Alarms)** > **모든 경보** > **경보 생성**
2.  **지표 선택** > **CWAgent** > **InstanceId**
3.  `mem_available_percent` 선택 > **지표 선택** 클릭

![](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-09-image-24.png)

### 조건 설정

| 설정 항목 | 권장 값 | 설명 |
| --- | --- | --- |
| **임계값 유형** | 정적 | 고정된 값으로 비교 |
| **조건** | 보다 작음 | 가용 메모리가 임계값 **미만**일 때 알람 |
| **임계값** | 20 | 가용 메모리 20% 미만 시 |
| **데이터 포인트** | 2/3 | 3번 중 2번 미만 시 알람 (노이즈 감소) |

> **⚠️ 조건 방향 주의**
> 
> `mem_used_percent`는 “높으면 위험”이라 **보다 큼**을 사용하지만, `mem_available_percent`는 “낮으면 위험”이라 **보다 작음**을 사용합니다. 방향을 반대로 설정하면 알람이 제대로 동작하지 않으니 주의하세요.

### 알림 설정

Part 1에서 생성한 SNS 주제를 재사용하거나 새로 생성합니다.

1.  **알람 상태 트리거**: “경보 상태” 선택
2.  **SNS 주제**: 기존 주제 선택 또는 새로 생성
3.  **알람 이름**: `EC2-Memory-Low-Available-Alert`
4.  **경보 생성** 클릭

## 비용 주의사항

CloudWatch Agent가 수집하는 메트릭은 **커스텀 메트릭**으로 분류되어 비용이 발생할 수 있습니다.

### Free Tier 한도

| 항목 | 무료 제공량 |
| --- | --- |
| 커스텀 메트릭 | **10개/월** |
| 알람 | 10개 |

### 이 글의 설정으로 사용되는 메트릭 개수

| 메트릭 | 개수 |
| --- | --- |
| mem\_used\_percent | 1 |
| mem\_available\_percent | 1 |
| disk\_used\_percent | 1 |
| disk\_free | 1 |
| cpu\_usage\_active | 1 |
| cpu\_usage\_idle | 1 |
| swap\_used\_percent | 1 |
| **합계** | **7개** |

**7개 메트릭은 Free Tier(10개) 범위 안입니다.** 추가 비용 없이 사용할 수 있습니다.

> **⚠️ 비용이 발생하는 경우**
> 
> -   메트릭 11개 이상: 초과분에 대해 $0.30/메트릭/월
> -   여러 인스턴스에 Agent 설치: 인스턴스별로 메트릭이 각각 카운트됨
> -   `resources: ["*"]`로 모든 디스크 수집: 마운트 포인트별로 메트릭 증가

## 트러블슈팅

### Agent가 시작되지 않을 때

**1\. 권한 문제 확인**

```php
# Agent 로그 확인
sudo cat /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

`AccessDenied` 에러가 보이면 IAM 역할이 제대로 연결되지 않은 것입니다.

**2\. IAM 역할 확인**

최근 EC2 인스턴스는 보안이 강화된 **IMDSv2**를 사용하므로 토큰이 필요합니다.

```php
<em># 토큰 발급</em>
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

<em># 토큰으로 IAM 역할 확인</em>
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

역할 이름이 출력되면 정상, 404 에러가 나면 역할이 연결되지 않은 것입니다.

> **💡 169.254.169.254는 뭔가요?**
> 
> EC2 **인스턴스 메타데이터 서비스(IMDS)** 주소입니다. 모든 EC2 인스턴스에서 이 IP로 접속하면 자기 자신의 정보(인스턴스 ID, IAM 역할, 리전 등)를 조회할 수 있습니다. AWS가 내부적으로 제공하는 특수한 링크-로컬 주소로, CloudWatch Agent도 이 주소를 통해 인스턴스 정보를 가져옵니다.
> 
> 예전에는 단순 curl로 접근 가능했지만(IMDSv1), 보안 취약점 때문에 최근 인스턴스는 토큰 기반의 **IMDSv2**가 기본입니다. ([AWS 문서](https://docs.aws.amazon.com/ko_kr/AWSEC2/latest/UserGuide/ec2-instance-metadata.html))

### CWAgent 네임스페이스가 안 보일 때

1.  Agent 상태 확인: `status`가 `running`인지 확인
2.  설정 파일 문법 확인: JSON 문법 오류가 있으면 Agent가 메트릭을 수집하지 못함
3.  인터넷 연결 확인: Agent가 CloudWatch 엔드포인트에 접근할 수 있어야 함

### 설정 파일 문법 검증

```php
# JSON 문법 검증
cat /opt/aws/amazon-cloudwatch-agent/bin/config.json | python3 -m json.tool
```

에러 없이 포맷팅된 JSON이 출력되면 문법은 정상입니다.

## 정리

이번 글에서 다룬 내용을 정리합니다.

**CloudWatch Agent**는 EC2 내부에 설치하는 프로그램으로, 기본 모니터링에서 제공하지 않는 메모리 사용률, 디스크 용량, swap 메모리 등을 수집합니다.

**설치 과정**은 IAM 역할 생성 → EC2에 역할 연결 → Agent 패키지 설치 → 설정 파일 작성 → Agent 시작 순서로 진행합니다.

**리소스 사용량**은 메트릭만 수집할 경우 CPU 1-5%, 메모리 50-100MB 정도로 t3.micro에서도 무난합니다.

**비용**은 이 글의 설정(7개 메트릭) 기준으로 Free Tier 범위 내이므로 추가 비용이 발생하지 않습니다.

**메트릭 확인**은 CloudWatch > 지표 > CWAgent 네임스페이스에서 할 수 있으며, 기본 모니터링과 동일하게 알람을 설정할 수 있습니다.

## 참고 자료

-   [서버에 CloudWatch 에이전트 설치 및 실행 – AWS 공식 문서](https://docs.aws.amazon.com/ko_kr/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Agent-commandline-fleet.html)
-   [CloudWatch 에이전트가 수집하는 지표 – AWS 공식 문서](https://docs.aws.amazon.com/ko_kr/AmazonCloudWatch/latest/monitoring/metrics-collected-by-CloudWatch-agent.html)
-   [CloudWatch Agent 높은 CPU 문제 해결 – AWS re:Post](https://repost.aws/knowledge-center/cloudwatch-agent-high-cpu)
-   [Amazon CloudWatch 요금](https://aws.amazon.com/cloudwatch/pricing/)
