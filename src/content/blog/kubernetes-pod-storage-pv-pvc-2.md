---
title: 'Kubernetes 스토리지 이해하기 (2): PV/PVC 실전 활용과 관리'
description: 'AccessModes 세 가지의 실제 의미, Deployment + RWO PVC 조합의 함정, PV 라이프사이클과 Reclaim Policy까지 — PV/PVC 실전 운영에서 마주치는 문제들.'
pubDate: '2026-01-12T19:01:00+09:00'
updatedDate: '2026-01-12T19:01:00+09:00'
category: tech
subcategory: 'Kubernetes'
tags: ['kubernetes', 'pv', 'pvc', 'storage']
---

## 들어가며

[이전 글](/kubernetes-pod-storage-pv-pvc-1/)에서는 Kubernetes 볼륨의 개념과 PV, PVC, StorageClass, CSI 드라이버의 동작 원리를 살펴봤습니다.

이번 글에서는 **실전 활용과 운영**에 초점을 맞춥니다:

-   한 Pod에 붙인 Volume을 다른 Pod에서도 쓸 수 있어?
-   Volume이 “떨어졌다”는 게 무슨 의미야?
-   PVC를 삭제하면 데이터는 어떻게 돼?
-   StatefulSet에서 스토리지는 어떻게 관리돼?
-   볼륨 크기를 실시간으로 늘릴 수 있어?

## AccessModes: 누가 어떻게 접근할 수 있나?

**“다른 Pod에서도 이 볼륨을 쓸 수 있나요?”**라는 질문의 답은 **AccessMode**에 달려 있습니다.

### 세 가지 AccessMode

| AccessMode | 약어 | 의미 |
| --- | --- | --- |
| **ReadWriteOnce** | RWO | 단일 노드에서 읽기/쓰기 |
| **ReadOnlyMany** | ROX | 여러 노드에서 읽기 전용 |
| **ReadWriteMany** | RWX | 여러 노드에서 읽기/쓰기 |

### 스토리지 타입별 지원 AccessMode

| 스토리지 | RWO | ROX | RWX |
| --- | --- | --- | --- |
| AWS EBS | ✅ | ❌ | ❌ |
| GCP PD | ✅ | ✅ | ❌ |
| Azure Disk | ✅ | ❌ | ❌ |
| NFS | ✅ | ✅ | ✅ |
| AWS EFS | ✅ | ✅ | ✅ |
| CephFS | ✅ | ✅ | ✅ |

> **RWO는 “단일 Pod”가 아니라 “단일 노드”입니다**
> 
> ReadWriteOnce는 **하나의 노드**에서만 마운트할 수 있다는 의미입니다. 같은 노드의 여러 Pod는 동일한 RWO 볼륨을 **마운트할 수 있습니다**.
> 
> 하지만 실제로는 대부분 하나의 Pod만 사용합니다:
> 
> -   여러 Pod가 같은 볼륨에 쓰면 **파일 충돌** 가능
> -   DB처럼 exclusive lock이 필요한 앱은 오류 발생
> -   따라서, **실무적으로 RWO + PVC = 단일 Pod 전용**으로 생각하면 됩니다

### Deployment + RWO PVC의 문제

**“Deployment로 replicas: 3을 설정하면 어떻게 되나요?”**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  template:
    spec:
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: my-pvc  # RWO 볼륨
```

**제약 사항:** RWO 볼륨은 **단일 노드에서만 마운트 가능**합니다. 따라서 3개의 Pod가 서로 다른 노드에 스케줄링되면, 첫 번째 Pod만 볼륨을 마운트하고 나머지는 실패합니다.

| 상황 | 결과 |
| --- | --- |
| 3개 Pod 모두 같은 노드 | 모두 마운트 가능 (RWO는 단일 **노드** 제한) |
| 3개 Pod가 다른 노드 | 1개만 성공, 나머지는 **Multi-Attach 에러** |

> **Scheduler는 Pod 스케줄링에 AZ만 고려하고, 노드에 걸린 RWO 제약은 고려하지 않습니다**
> 
> Scheduler는 PV의 `nodeAffinity`를 보고 **볼륨이 있는 AZ의 노드에만** Pod를 스케줄링합니다. 예를 들어 EBS 볼륨이 AZ-a에 있으면, Pod는 AZ-a의 노드에만 배치됩니다.
> 
> 하지만 **같은 AZ 내에 노드가 여러 개**라면? Scheduler는 그중 아무 노드나 선택할 수 있습니다. RWO 볼륨이 이미 Node-1에 attach되어 있어도, Scheduler는 Node-2에 Pod를 스케줄링할 수 있어요.
> 
> ```
> AZ-a에 Node-1, Node-2, Node-3 존재
> RWO 볼륨이 Node-1에 attach됨
> 
> Pod-1 → Node-1 스케줄링 → attach 성공 ✅
> Pod-2 → Node-2 스케줄링 → attach 시도 → Multi-Attach 에러 ❌
> Pod-3 → Node-3 스케줄링 → attach 시도 → Multi-Attach 에러 ❌
> ```
> 
> **CSI 드라이버가 attach 시점에 거부**하면서 에러가 발생합니다.

**해결책:**

| 방법 | 설명 |
| --- | --- |
| **RWX 스토리지** | NFS, EFS 등 여러 노드에서 동시 마운트 가능 |
| **StatefulSet** | 각 Pod마다 별도 PVC 자동 생성 |
| **replicas: 1** | RWO + Deployment면 단일 replica만 안전 |

### 여러 Pod에서 볼륨 공유하기

여러 Pod에서 동일한 데이터를 공유하려면 **ReadWriteMany** (RWX) 를 지원하는 스토리지가 필요합니다.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-pvc
spec:
  accessModes:
    - ReadWriteMany  # 여러 노드에서 읽기/쓰기 가능
  resources:
    requests:
      storage: 10Gi
  storageClassName: efs-storage  # NFS/EFS 기반 StorageClass
```

RWX가 필요한 사용 사례:

-   여러 웹 서버가 공유하는 정적 파일
-   ML 학습 데이터 공유
-   로그 파일 중앙 저장

## PV 라이프사이클과 Reclaim Policy

**“Volume이 떨어졌다”**는 표현을 들어본 적 있나요? 이건 PV의 라이프사이클과 관련이 있습니다.

### PVC와 PV는 Pod와 독립적입니다

Deployment를 수정해서 volumes 섹션을 제거하더라도, PVC와 PV는 **독립적인 리소스**이므로 그대로 유지됩니다.

```yaml
# Before: PVC 마운트
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-pvc

# After: volumes 섹션 제거해도
# → PVC는 그대로 존재
# → PV도 그대로 존재
# → PVC-PV 바인딩도 유지
```

PVC를 삭제하려면 명시적으로 `kubectl delete pvc my-pvc` 해야 합니다.

### PV 상태 (Phase)

![PersistentVolume 상태 전이도 — PV 생성 후 Available → PVC 바인딩 시 Bound → PVC 삭제 시 정책에 따라 Delete(삭제) 또는 Retain(Released), Released에서 claimRef 제거로 Available 재사용](/images/kubernetes-pod-storage-pv-pvc-2/img-01-image-5.png)

| 상태 | 의미 |
| --- | --- |
| **Available** | 아직 PVC에 바인딩되지 않음, 사용 가능 |
| **Bound** | PVC에 바인딩됨, 사용 중 |
| **Released** | 바인딩된 PVC가 삭제됨, 아직 사용 불가 |
| **Failed** | 자동 회수 실패 |

“Volume이 떨어졌다”는 보통 **PVC가 삭제되어 PV가 Released 상태**가 된 경우를 말합니다.

### Reclaim Policy: PVC 삭제 후 PV 처리 방식

PVC를 삭제하면 바인딩된 PV는 어떻게 될까요? **Reclaim Policy**가 결정합니다.

| Policy | 동작 | 데이터 |
| --- | --- | --- |
| **Retain** | PV 유지, Released 상태로 전환 | 보존 |
| **Delete** | PV와 실제 스토리지 **즉시** 삭제 | 삭제 |

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: retain-storage
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain  # PVC 삭제해도 PV와 데이터 유지
```

> **동적 프로비저닝의 기본 Reclaim Policy는 Delete입니다**
> 
> 중요한 데이터가 있는 PVC를 삭제하면 **데이터가 영구 삭제**될 수 있습니다! **유예 기간 없이 즉시 삭제**되므로 복구가 불가능합니다. 프로덕션 환경에서는 `Retain` 정책을 사용하거나, 삭제 전 백업을 권장합니다.

### Reclaim Policy 변경하기

**방법 1: 새 StorageClass 만들기** (권장)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-retain  # Retain 정책의 새 StorageClass
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
parameters:
  type: gp3
```

**방법 2: 이미 생성된 PV의 reclaimPolicy 수정**

```bash
kubectl patch pv my-pv -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

reclaimPolicy는 **PVC가 삭제되는 시점**에 참조됩니다. 따라서 PV 생성 후에 정책을 수정해도 효과가 있습니다. 중요한 데이터가 있는 PV라면, PVC 삭제 전에 미리 Retain으로 변경해두세요.

> **StorageClass는 누가 만드나?**
> 
> 일반적으로 **클러스터 관리자**가 만들어 둡니다. 개발자도 권한이 있으면 만들 수 있지만, 보통은 관리자가 제공하는 StorageClass를 사용합니다. 필요한 reclaimPolicy가 있다면 관리자에게 요청하거나, 이미 생성된 PV의 정책을 수동으로 변경할 수 있습니다.

### Released 상태의 PV 재사용하기

`Retain` 정책으로 보존된 PV는 **자동으로 새 PVC에 바인딩되지 않습니다**. 이전 데이터가 남아있어 보안상 의도적으로 막아둔 것입니다.

똑같은 이름의 PVC를 다시 만들어도 자동 바인딩되지 않습니다. 재사용하려면:

1.  데이터 백업 (필요시)
2.  PV의 `spec.claimRef` 필드 삭제
3.  PV 상태가 `Available`로 변경됨
4.  새 PVC가 바인딩 가능

```bash
# claimRef 제거 → Available 상태로 전환
kubectl patch pv my-pv -p '{"spec":{"claimRef": null}}'
```

> **Volume이 “떨어진” 상황 복구하기**
> 
> PVC가 실수로 삭제되어 PV가 Released 상태가 됐다면:
> 
> 1.  `kubectl get pv`로 PV 상태 확인
> 2.  Reclaim Policy가 `Retain`이면 데이터는 안전
> 3.  `claimRef`를 제거하여 Available 상태로 전환
> 4.  새 PVC 생성하면 바인딩됨
> 
> 만약 Reclaim Policy가 `Delete`였다면… 데이터는 이미 삭제됐을 가능성이 높습니다.

## StatefulSet과 스토리지

[Kubernetes 컴퓨팅 이해하기 (1)](/kubernetes-computing-pod-lifecycle/)에서 StatefulSet을 간단히 소개했습니다. StatefulSet은 **상태가 있는 애플리케이션**(DB, Kafka 등)을 위한 것으로, 스토리지와 깊은 관계가 있습니다.

### StatefulSet의 volumeClaimTemplates

Deployment는 PVC를 직접 참조하지만, StatefulSet은 **volumeClaimTemplates**를 사용해 **각 Pod마다 별도의 PVC를 자동 생성**합니다.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:  # 각 Pod마다 PVC 자동 생성
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 10Gi
```

이 StatefulSet을 생성하면:

```text
Pod 이름          → PVC 이름
postgres-0       → data-postgres-0
postgres-1       → data-postgres-1
postgres-2       → data-postgres-2
```

### StatefulSet의 스토리지 특징

| 동작 | Deployment | StatefulSet |
| --- | --- | --- |
| Pod 이름 | 랜덤 (my-app-7d8f…) | 순번 고정 (my-app-0, 1, 2) |
| PVC | 공유하거나 직접 생성 | Pod당 자동 생성 |
| Pod 재시작 | 새 Pod는 다른 PVC 사용 가능 | 같은 번호 Pod는 같은 PVC 사용 |
| 스케일 다운 | PVC 유지 정책에 따름 | PVC 삭제 안 됨 (기본) |

### Pod 재시작 시 스토리지

```text
postgres-0 종료 → postgres-0 재생성 → data-postgres-0에 다시 바인딩
```

StatefulSet의 Pod가 재시작되면, **같은 이름의 Pod가 같은 PVC에 다시 연결**됩니다. 데이터는 그대로 유지됩니다.

### 스케일 업/다운 시 스토리지

**스케일 업 (replicas: 3 → 5):**

```text
기존: postgres-0, postgres-1, postgres-2
추가: postgres-3 생성 → data-postgres-3 PVC 자동 생성
      postgres-4 생성 → data-postgres-4 PVC 자동 생성
```

**스케일 다운 (replicas: 5 → 3):**

```text
삭제: postgres-4 삭제 (Pod만)
      postgres-3 삭제 (Pod만)
PVC:  data-postgres-3, data-postgres-4는 유지됨!
```

> **스케일 다운해도 PVC는 삭제되지 않습니다**
> 
> 이건 **데이터 보호를 위한 의도적인 설계**입니다. 다시 스케일 업하면 기존 PVC가 재사용됩니다.
> 
> PVC를 삭제하려면 수동으로 해야 합니다:
> 
> ```javascript
> kubectl delete pvc data-postgres-3 data-postgres-4
> ```

### StatefulSet 삭제 시 스토리지

```bash
kubectl delete statefulset postgres
```

StatefulSet을 삭제해도 **PVC는 삭제되지 않습니다**. 완전히 정리하려면:

```bash
# StatefulSet 삭제
kubectl delete statefulset postgres

# PVC도 삭제 (데이터 완전 삭제)
kubectl delete pvc -l app=postgres
```

### 분산 DB 스케일 다운 시 주의사항

StatefulSet은 PVC를 보존하지만, **분산 DB에서는 앱 레벨의 데이터 처리가 필요**합니다.

**일반 StatefulSet (예: 단순 웹앱):**

```text
replicas: 5 → 3
Pod-4, Pod-3 삭제 → PVC는 유지 → 데이터 손실 없음
```

**분산 DB (예: Cassandra, MongoDB ReplicaSet):**

```text
replicas: 5 → 3
문제: Pod-3, Pod-4가 갖고 있던 데이터 샤드는?
→ 데이터가 다른 노드에 복제되어 있으면 OK
→ 복제 안 됐으면 데이터 손실!
```

| DB 종류 | 스케일 다운 전 필요한 작업 |
| --- | --- |
| **Cassandra** | `nodetool decommission`으로 데이터 이전 |
| **MongoDB** | replica set에서 멤버 제거 |
| **PostgreSQL (Patroni)** | leader가 아닌 replica만 제거 |
| **Kafka** | partition reassignment 실행 |

> **결론: StatefulSet replica 함부로 줄이지 마세요**
> 
> StatefulSet 자체는 PVC를 보존하지만, 분산 시스템에서는 **앱 레벨에서 데이터 재배치가 먼저** 필요합니다. DB 문서를 확인하고 안전한 절차를 따르세요.

### 데이터를 안전하게 보존하려면?

| 방법 | 설정 |
| --- | --- |
| **Reclaim Policy: Retain** | PVC 삭제해도 PV/데이터 유지 |
| **스케일 다운** | 기본적으로 PVC 유지 (분산 DB는 앱 레벨 처리 필요) |
| **StatefulSet 삭제** | 기본적으로 PVC 유지 |
| **PVC 삭제 전 백업** | velero 등 백업 도구 사용 |

## Volume Expansion: 크기 늘리기

**“실시간으로 볼륨 크기를 늘릴 수 있나요?”** 네, 가능합니다!

### 볼륨 확장 조건

1.  **StorageClass에 `allowVolumeExpansion: true`** 설정
2.  **CSI 드라이버가 볼륨 확장 지원**
3.  **동적 프로비저닝된 PVC**만 가능

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: expandable
provisioner: ebs.csi.aws.com
allowVolumeExpansion: true  # 이게 있어야 확장 가능
```

### 볼륨 확장 방법

PVC의 `spec.resources.requests.storage`를 수정하면 됩니다.

```bash
# 기존 PVC 확인
kubectl get pvc my-pvc
# NAME     STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Bound    pvc-xxx   10Gi       RWO            expandable

# PVC 크기 수정
kubectl patch pvc my-pvc -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'

# 확장 후 확인
kubectl get pvc my-pvc
# NAME     STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Bound    pvc-xxx   20Gi       RWO            expandable
```

### 온라인 vs 오프라인 확장

| 확장 방식 | 설명 | 지원 여부 |
| --- | --- | --- |
| **온라인** | Pod 실행 중 확장 (무중단) | 대부분의 최신 CSI 드라이버 |
| **오프라인** | Pod 재시작 필요 | 일부 레거시 드라이버 |

Kubernetes 1.24부터 볼륨 확장이 Stable 기능이 됐고, 대부분의 CSI 드라이버는 **온라인 확장**을 지원합니다.

> **볼륨 축소는 안 됩니다!**
> 
> Kubernetes는 볼륨 **확장**만 지원합니다. 한번 늘린 볼륨은 줄일 수 없습니다. 처음부터 적절한 크기로 시작하고, 필요할 때 늘리는 전략을 권장합니다.

## 블록 스토리지 vs 오브젝트 스토리지

같은 스토리지라는 이름이 붙어 있기 때문에, **“S3 같은 스토리지를 Pod에 붙이는 것과 뭐가 달라?”**라는 생각이 들 수 있습니다.

### 두 가지 스토리지 타입

| 구분 | 블록 스토리지 | 오브젝트 스토리지 |
| --- | --- | --- |
| **예시** | AWS EBS, GCP PD, Azure Disk | AWS S3, GCS, MinIO |
| **접근 방식** | 파일시스템 마운트 (OS 레벨) | API 호출 (애플리케이션 레벨) |
| **Pod 연결** | PV/PVC로 마운트 | SDK/API로 접근 |
| **데이터 구조** | 파일/폴더 계층 구조 | Key-Value (객체) |
| **사용 사례** | DB, 로그, 일반 파일 저장 | 이미지, 백업, 정적 파일 |

### PV/PVC는 블록 스토리지용

Kubernetes의 PV/PVC 시스템은 **블록 스토리지**를 위한 것입니다. 디스크를 Pod에 마운트해서 파일시스템처럼 사용합니다.

```yaml
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: my-pvc  # EBS 같은 블록 스토리지
```

### S3는 애플리케이션에서 직접 접근

S3 같은 오브젝트 스토리지는 PV/PVC로 마운트하지 않습니다. 애플리케이션 코드에서 SDK로 직접 접근합니다.

```yaml
# S3 접근을 위한 환경변수/시크릿 주입
env:
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: aws-secret
        key: access-key
  - name: S3_BUCKET
    value: my-app-bucket
```

> **Langfuse 같은 앱에서 S3 호환 스토리지를 설정하는 건?**
> 
> 이건 **애플리케이션 레벨**의 설정입니다. Pod에 S3 접속 정보(endpoint, access key 등)를 환경변수로 전달하고, 앱이 S3 API로 데이터를 저장합니다.
> 
> PV/PVC와는 별개의 개념이며, 동시에 사용할 수도 있습니다:
> 
> -   **PVC**: DB 데이터 저장 (블록 스토리지)
> -   **S3**: 파일 업로드 저장 (오브젝트 스토리지)

## 트러블슈팅

### PVC가 Pending 상태인 경우

```bash
kubectl get pvc
# NAME     STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Pending                                       fast-ssd
```

**확인해야 할 것들:**

| 원인 | 확인 방법 | 해결책 |
| --- | --- | --- |
| StorageClass 없음 | `kubectl get sc` | StorageClass 생성 |
| CSI 드라이버 미설치 | `kubectl get pods -n kube-system` | CSI 드라이버 설치 |
| 용량 부족 | 클라우드 콘솔에서 할당량 확인 | 할당량 증가 요청 |
| AZ 불일치 | `volumeBindingMode` 확인 | `WaitForFirstConsumer` 사용 |

```bash
# 상세 원인 확인
kubectl describe pvc my-pvc
# Events 섹션에서 에러 메시지 확인
```

### Volume attach/detach history 확인

```bash
# PV 이벤트 확인
kubectl describe pv my-pv

# Pod 이벤트 확인 (Volume 관련)
kubectl describe pod my-pod | grep -A 10 Events

# CSI 드라이버 로그 확인
kubectl logs -n kube-system -l app=ebs-csi-controller
```

### 흔한 문제들

| 문제 | 증상 | 해결책 |
| --- | --- | --- |
| Multi-Attach 에러 | RWO 볼륨을 여러 노드에서 사용 시도 | 기존 Pod 삭제 또는 RWX 스토리지 사용 |
| Volume mount timeout | Pod가 ContainerCreating에서 멈춤 | CSI 드라이버 상태 확인, 노드 상태 확인 |
| Filesystem resize 실패 | 확장 후 용량이 안 늘어남 | Pod 재시작 (오프라인 확장인 경우) |
| Released PV 재사용 불가 | PVC 삭제 후 PV가 Available 안 됨 | claimRef 수동 제거 |

## 마무리

이 글에서는 PV/PVC의 실전 활용과 운영에 대해 살펴봤습니다.

**핵심 내용:**

-   **AccessMode**: RWO는 실무적으로 단일 Pod 전용, 여러 Pod 공유는 RWX 필요
-   **Reclaim Policy**: Delete는 즉시 삭제, 프로덕션은 Retain 권장
-   **Released PV**: 자동 재연결 안 됨, claimRef 제거 필요
-   **StatefulSet**: volumeClaimTemplates로 Pod당 PVC 자동 생성, 스케일 다운해도 PVC 유지
-   **분산 DB 스케일 다운**: 앱 레벨 데이터 재배치 먼저 필요
-   **Volume Expansion**: 확장만 가능, 축소 불가

**트러블슈팅 키워드:**

-   PVC Pending → StorageClass, CSI 드라이버, AZ 확인
-   Multi-Attach 에러 → RWO 볼륨을 여러 노드에서 사용 시도
-   Volume mount timeout → CSI 드라이버/노드 상태 확인

**이로써 Kubernetes 이해하기 시리즈가 완성됐습니다:**

| 시리즈 | 핵심 질문 |
| --- | --- |
| [네트워크 이해하기 (1)](/kubernetes-network-guide-1-external-to-pod/) | 외부 요청이 Pod에 어떻게 도달할까? |
| [네트워크 이해하기 (2)](/kubernetes-network-guide-2-pod-to-pod/) | Pod끼리 어떻게 통신할까? |
| [컴퓨팅 이해하기 (1)](/kubernetes-computing-pod-lifecycle/) | Pod는 어떻게 배치되고 실행될까? |
| [스토리지 이해하기 (1)](/kubernetes-pod-storage-pv-pvc-1/) | Pod는 볼륨을 어떻게 사용할까? |
| [스토리지 이해하기 (2)](/kubernetes-pod-storage-pv-pvc-2/) | PV/PVC를 어떻게 관리할까? |

## 참고 자료

-   [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
-   [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
-   [Volume Expansion](https://kubernetes.io/blog/2022/05/05/volume-expansion-ga/)
-   [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
-   [Node Affinity in PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity)
