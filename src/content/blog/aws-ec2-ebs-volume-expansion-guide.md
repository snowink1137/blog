---
title: 'AWS EC2 용량 부족? 5분 만에 EBS 볼륨 늘리기'
description: '디스크가 가득 찬 EC2에서 EBS 볼륨을 무중단으로 확장하는 방법. 디스크 상태 진단, docker system prune 응급 처치, 볼륨 확장 후 파티션·파일시스템 적용까지.'
pubDate: '2026-01-02T13:50:07+09:00'
updatedDate: '2026-01-02T13:50:07+09:00'
category: tech
subcategory: 'AWS'
tags: ['aws', 'ebs', 'ec2', 'linux']
---

## 서론

AWS EC2에서 WordPress를 운영 중에 갑자기 사이트가 멈췄습니다. SSH로 접속해보니 MySQL이 죽어있었고, 원인은 단순했습니다. **디스크 100%**. t3.micro Ubuntu AMI 기본값인 8GB로는 Docker 이미지 몇 개만 올려도 금방 차버리더라고요.

이 글에서는 제가 직접 겪은 디스크 풀 상황에서 EBS 볼륨을 확장하고, 재부팅 없이 바로 적용한 과정을 공유합니다.

## 문제 진단: 디스크 상태 확인하기

먼저 현재 디스크 상태를 확인합니다.

```bash
df -h
```
```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/root       6.8G  6.7G    0  100% /
```

Use%가 100%라면 문제가 확실합니다. 이제 어디서 용량을 많이 잡아먹는지 찾아봅니다.

```bash
sudo du -sh /* 2>/dev/null | sort -hr | head -10
```

보통 `/var/lib/docker`(Docker 이미지/볼륨)나 `/var/log`(로그 파일)가 주범인 경우가 많습니다. 더 깊이 파고 싶다면 해당 디렉토리를 다시 확인하면 됩니다.

```bash
sudo du -sh /var/lib/* 2>/dev/null | sort -hr | head -10
```

## 응급 처치: 당장 용량 확보하기

EBS 볼륨 확장 전에 급한 불부터 끄고 싶다면, 아래 명령어로 500MB~1GB 정도 확보할 수 있습니다.

```bash
# apt 캐시 정리 (~200MB)
sudo apt clean
sudo apt autoremove -y

# systemd 저널 로그 정리
sudo journalctl --vacuum-size=100M
```

### docker system prune, 해도 되나요?

Docker 정리 명령어 중 `docker system prune -a --volumes`는 주의가 필요합니다.

-   `--volumes` 옵션은 **사용하지 않는 볼륨을 삭제**합니다.
-   문제는 컨테이너가 죽어서 stopped 상태라면, 해당 볼륨이 “미사용”으로 간주될 수 있다는 점입니다.
-   DB 데이터가 볼륨에 있다면 날아갈 수 있으니, **`--volumes` 없이** 실행하는 게 안전합니다.

```bash
# 안전한 버전: 볼륨은 건드리지 않음
docker system prune -a
```

## 근본 해결: AWS에서 EBS 볼륨 확장하기

응급 처치는 임시방편입니다. 8GB로는 WordPress + MySQL 운영이 빠듯하니, EBS 볼륨 자체를 늘리는 게 정답입니다.

![](/images/aws-ec2-ebs-volume-expansion-guide/img-01-image.png)

**AWS 콘솔 작업 순서:**

1.  AWS Console → EC2 → 좌측 메뉴 **Elastic Block Store** → **Volumes**
2.  해당 인스턴스에 연결된 볼륨 선택
3.  **Actions** → **Modify volume**
4.  Size를 원하는 크기(예: 20GB)로 변경 후 **Modify**

### 프리티어 요금은 얼마인가요?

AWS 프리티어에서 EBS는 **30GB까지 무료**입니다 (12개월간). 8GB → 20GB로 늘려도 추가 비용이 없습니다.

프리티어 종료 후 요금은 다음과 같습니다:

| 타입 | 가격 |
| --- | --- |
| gp3 | $0.08/GB-month |
| gp2 | $0.10/GB-month |

20GB gp3 기준 월 $1.60, 30GB라도 월 $2.40 수준이라 부담이 크지 않습니다.

## EC2에서 늘어난 용량 적용하기

AWS 콘솔에서 볼륨 크기를 변경해도 **EC2 내부에서는 자동으로 반영되지 않습니다**. 파티션과 파일시스템을 직접 확장해줘야 합니다.

### 현재 상태 확인

```bash
lsblk
```
```text
NAME          SIZE  TYPE MOUNTPOINTS
nvme0n1        20G  disk
├─nvme0n1p1     7G  part /
├─nvme0n1p14    4M  part
├─nvme0n1p15  106M  part /boot/efi
└─nvme0n1p16  913M  part /boot
```

디스크(`nvme0n1`)는 20GB로 늘었지만, 루트 파티션(`nvme0n1p1`)은 아직 7GB입니다. 13GB가 할당되지 않은 빈 공간으로 남아있는 상태입니다.

### 파티션 확장

```bash
sudo growpart /dev/nvme0n1 1
```

이 명령어는 `nvme0n1` 디스크의 **1번 파티션을 디스크 끝까지 확장**합니다.

```text
CHANGED: partition=1 start=2099200 old: size=14677983 end=16777182 new: size=39843807 end=41943006
```

> 💡 **파티션이란?** 하나의 디스크를 논리적으로 나눈 조각입니다. 피자 한 판(디스크)을 여러 조각(파티션)으로 자르는 것과 비슷합니다. AWS에서 EBS 볼륨을 늘리면 피자 판 자체가 커지지만, 조각 경계는 그대로입니다. `growpart`는 이 조각 경계를 늘려주는 역할을 합니다.

### 파일시스템 확장

파티션을 늘렸지만 아직 끝이 아닙니다. `df -h`를 실행하면 여전히 6.8GB로 표시됩니다.

```bash
sudo resize2fs /dev/nvme0n1p1
```
```text
resize2fs 1.47.0 (5-Feb-2023)
Filesystem at /dev/nvme0n1p1 is mounted on /; on-line resizing required
The filesystem on /dev/nvme0n1p1 is now 4980475 (4k) blocks long.
```

> 💡 **파일시스템이란?** 파티션 안에서 파일을 저장하고 관리하는 방식입니다. 파티션이 방 크기라면, 파일시스템은 그 안의 가구 배치라고 생각하면 됩니다. `resize2fs`는 늘어난 방 크기에 맞게 가구 배치를 재조정하는 명령어입니다.

### 재부팅이 필요한가요?

**아니요.** 출력 메시지의 `on-line resizing required`가 의미하듯, 마운트된 상태에서 실시간으로 확장됩니다. 서비스 중단 없이 바로 적용됩니다.

### 최종 확인

```bash
df -h
```
```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/root        19G  6.6G   12G  36% /
```

19GB로 늘어났고, 12GB 여유 공간이 생겼습니다! 이제 죽었던 컨테이너를 재시작하면 됩니다.

```bash
cd ~/wordpress  # docker-compose.yml 위치
docker compose restart
```

## 마무리

EC2 디스크가 꽉 찼을 때 해결 과정을 정리하면 다음과 같습니다.

1.  **진단**: `df -h`, `du -sh`로 용량 확인
2.  **AWS 콘솔**: EBS 볼륨 크기 변경 (Modify volume)
3.  **EC2 적용**: `growpart` → `resize2fs` (재부팅 필요 없음)

Ubuntu AMI 기본값 8GB는 솔직히 너무 작습니다. WordPress나 Docker를 운영할 계획이라면 **처음부터 16~20GB로 설정**하는 걸 추천합니다. 프리티어 30GB 한도 내에서 무료이고, 프리티어 종료 후에도 월 $2 미만이니까요.

## 참고 자료

-   [AWS EBS Elastic Volumes를 사용한 볼륨 수정](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html) – AWS 공식 문서
-   [Amazon EBS 볼륨 크기 조정 후 파일 시스템 확장](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html) – growpart, resize2fs 상세 가이드
-   [Amazon EBS 요금](https://aws.amazon.com/ebs/pricing/) – 프리티어 30GB 포함 요금 정보
