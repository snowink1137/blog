---
title: 'Kubernetes 스토리지 이해하기 (1): Pod는 데이터를 어떻게 저장하고 유지하는가'
description: 'Kubernetes 볼륨 개념부터 emptyDir·hostPath 같은 Volume 타입, 그리고 PV/PVC로 Pod와 스토리지의 생명주기를 분리하는 구조까지 — 스토리지 시리즈 첫 편.'
pubDate: '2026-01-11T19:56:00+09:00'
updatedDate: '2026-01-11T19:56:00+09:00'
category: tech
subcategory: 'Kubernetes'
tags: ['csi', 'kubernetes', 'pv', 'pvc', 'storage']
---

## 들어가며

[이전 글](/kubernetes-computing-pod-lifecycle/)에서는 Kubernetes에서 Pod가 어떻게 생성되고 실행되는지 살펴봤습니다. Scheduler가 노드를 선택하고, kubelet이 컨테이너를 실행하는 과정을 알게 됐죠.

그런데 한 가지 문제가 있습니다. **Pod가 죽으면 그 안의 데이터도 함께 사라집니다.**

데이터베이스를 Pod로 운영한다고 생각해보세요. Pod가 재시작될 때마다 데이터가 날아간다면 서비스가 될 수 없겠죠. 그래서 Kubernetes는 Pod의 라이프사이클과 독립적인 **영구 저장소** (Persistent Storage) 를 제공합니다.

이 글에서는 다음 질문들에 답합니다:

-   Kubernetes에서 말하는 “볼륨”은 뭐야?
-   PV(PersistentVolume)와 PVC(PersistentVolumeClaim)는 뭐가 다른 거야?
-   볼륨은 실제로 어디에 존재하는 거야?
-   Pod가 다른 노드로 재시작되면 볼륨은 어떻게 돼?
-   CSI 드라이버는 어떻게 동작해?

## 볼륨이란 무엇인가?

본격적인 내용에 앞서, **볼륨** (Volume) 이라는 용어를 정리해보겠습니다. Kubernetes의 “볼륨”은 일반적인 스토리지 용어와 **다른 의미**로 사용됩니다.

### 일반적인 스토리지 용어로서의 “볼륨”

우리가 보통 아는 볼륨은 **저장 공간 자체**를 의미합니다. AWS EBS도 “Elastic Block Store **Volume**“이라고 부르죠.

### Kubernetes에서의 “볼륨”

Kubernetes Volume은 **스토리지를 Pod에 연결하는 방법**을 정의하는 추상화입니다.

```text
이미 존재하는 스토리지 (EBS 볼륨, NFS, 노드 디스크, ConfigMap 등)
    ↓
Kubernetes Volume (Pod에 연결하기 위한 추상화)
    ↓
컨테이너의 특정 경로에 마운트 (/data)
```

[Kubernetes 공식 문서](https://kubernetes.io/docs/concepts/storage/volumes/)에서도 이렇게 설명합니다:

> “At its core, a volume is a directory, possibly with some data in it, which is accessible to the containers in a pod.”

즉, Kubernetes 볼륨은 “스토리지 자체”가 아니라 **“Pod 내 컨테이너가 접근할 수 있는 디렉토리”**입니다. 같은 단어지만 레이어가 다른 개념이에요.

| 용어 | 일반적인 의미 | Kubernetes에서의 의미 |
| --- | --- | --- |
| **볼륨** | 스토리지 자체 (EBS, 디스크) | 스토리지를 Pod에 연결하는 설정 |

## 전체 그림: Pod의 volumes와 Volume 타입들

### YAML 구조로 이해하기

Pod에서 스토리지를 사용하려면 `spec.volumes[]`에 정의합니다. **`volumes`가 상위 개념**이고, 그 안에 여러 **타입**이 같은 레벨로 들어갑니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - mountPath: /cache
          name: temp-storage
        - mountPath: /data
          name: persistent-storage
        - mountPath: /config
          name: config-storage
  volumes:                           # ← 상위 개념
    - name: temp-storage
      emptyDir: {}                   # 타입 1: 임시 저장소
    
    - name: persistent-storage
      persistentVolumeClaim:         # 타입 2: PVC 참조
        claimName: my-pvc
    
    - name: config-storage
      configMap:                     # 타입 3: ConfigMap
        name: my-config
```

### Volume 타입들

![Pod 볼륨 구조도 — Pod의 volumeMounts가 spec.volumes[]의 emptyDir·persistentVolumeClaim·configMap에 연결되고, PVC는 PV를 거쳐 실제 스토리지(AWS EBS·NFS)로 이어짐](/images/kubernetes-pod-storage-pv-pvc-1/img-01-image.png)

| Volume 타입 | 설명 | 데이터 지속성 |
| --- | --- | --- |
| `emptyDir` | Pod 임시 저장소 | Pod 삭제 시 삭제 |
| `hostPath` | 노드의 경로 직접 참조 | 노드에 종속 |
| `configMap` | ConfigMap 데이터 마운트 | ConfigMap 수명 주기에 따름 |
| `secret` | Secret 데이터 마운트 | Secret 수명 주기에 따름 |
| **`persistentVolumeClaim`** | PVC 참조 → 영구 저장소 | **Pod와 독립** |

**`persistentVolumeClaim` 타입을 사용할 때만 PVC/PV라는 별도 리소스가 관여합니다.**

![Volume 타입 개요 — spec.volumes[]의 emptyDir·hostPath·configMap·secret·persistentVolumeClaim, 그리고 PVC→PV→실제 스토리지로 이어지는 바인딩](/images/kubernetes-pod-storage-pv-pvc-1/img-02-image-1.png)

### emptyDir: 빈 디렉토리로 시작하는 공유 볼륨

**“emptyDir”**이라는 이름은 Pod가 생성될 때 **빈 디렉토리** (empty directory) 로 시작하기 때문입니다.

```text
Pod 스케줄링 → 노드에 빈 디렉토리 생성 → 컨테이너들이 데이터를 채워넣음 → Pod 삭제 시 함께 삭제
```

Pod 내 컨테이너들이 데이터를 공유할 때 유용하지만, **Pod가 삭제되면 데이터도 사라집니다**.

```yaml
volumes:
  - name: cache
    emptyDir: {}  # Pod가 죽으면 데이터도 삭제
```

> **emptyDir의 옵션들**
> 
> `emptyDir: {}`에서 `{}`는 기본 설정을 사용한다는 의미입니다.
> 
> ```yaml
> volumes:
>   - name: cache
>     emptyDir: {}  # 기본: 노드의 디스크에 저장
> 
>   - name: fast-cache
>     emptyDir:
>       medium: Memory   # RAM에 저장 (tmpfs, 더 빠름)
>       sizeLimit: 500Mi # 최대 크기 제한
> ```
> 
> | 옵션 | 설명 |
> | --- | --- |
> | `medium: ""` (기본) | 노드의 디스크에 저장 |
> | `medium: Memory` | RAM에 저장 (빠르지만 노드 메모리 사용) |
> | `sizeLimit` | 최대 사용량 제한 |

### persistentVolumeClaim: 영구 저장소 연결

**Pod와 독립적으로 데이터를 유지**하려면 `persistentVolumeClaim` 타입을 사용합니다. 이 타입은 PVC라는 별도 리소스를 참조합니다.

```yaml
volumes:
  - name: db-data
    persistentVolumeClaim:
      claimName: postgres-pvc  # PVC 이름 참조
```

다음 섹션에서 PVC와 PV를 자세히 살펴보겠습니다.

## PVC와 PV: 영구 저장소의 핵심

### PersistentVolume (PV): 클러스터 레벨의 스토리지 자원

**PV는 클러스터에 프로비저닝된 실제 스토리지**입니다. AWS EBS, GCP PD, NFS 서버 등과 연결됩니다.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: gp3
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0123456789abcdef0
    fsType: ext4
```

**PV spec 주요 필드:**

| 필드 | 설명 |
| --- | --- |
| `capacity.storage` | 볼륨 크기 |
| `accessModes` | 접근 모드 (RWO, ROX, RWX) |
| `persistentVolumeReclaimPolicy` | PVC 삭제 시 처리 방식 (Retain, Delete) |
| `storageClassName` | 연결할 StorageClass 이름 |
| `csi.driver` | 사용할 CSI 드라이버 이름 |
| `csi.volumeHandle` | 실제 스토리지의 ID (예: AWS EBS volume ID) |
| `csi.fsType` | 파일시스템 타입 (ext4, xfs 등) |

PV의 특징:

-   **클러스터 레벨 리소스**: 특정 네임스페이스에 속하지 않음
-   **Pod와 독립적인 라이프사이클**: Pod가 죽어도 데이터 유지
-   **실제 스토리지와 연결**: 클라우드 디스크, NFS, iSCSI 등

> **In-tree 플러그인 vs CSI**
> 
> 위 예시의 `csi:` 블록은 **CSI(Container Storage Interface)** 방식입니다. 예전에는 `awsElasticBlockStore:` 같은 **in-tree 플러그인**이 Kubernetes 코어에 내장되어 있었지만, 현재는 deprecated 상태입니다.
> 
> | 방식 | 설명 | 상태 |
> | --- | --- | --- |
> | **In-tree** | K8s 코어에 내장 (awsElasticBlockStore 등) | Deprecated |
> | **CSI** | 외부 드라이버로 설치 | 권장 |
> 
> 관리형 Kubernetes(EKS, GKE, AKS)에서는 CSI 드라이버가 기본 설치되어 있습니다.

### PersistentVolumeClaim (PVC): 사용자의 스토리지 요청서

**PVC는 개발자가 “이런 스토리지가 필요해”라고 요청하는 것**입니다. PV를 직접 지정하지 않고, 원하는 조건(용량, 접근 모드 등)만 명시합니다.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: gp3  # 이 StorageClass를 사용해 동적 프로비저닝
```

Kubernetes가 조건에 맞는 PV를 찾아 **바인딩** (Binding) 해줍니다.

> **왜 PV와 PVC를 분리했을까?**
> 
> **역할 분리** 때문입니다:
> 
> -   **클러스터 관리자**: StorageClass와 스토리지 인프라 관리
> -   **개발자**: PVC로 스토리지 요청 (얼마나, 어떤 접근 모드로)
> 
> 개발자는 스토리지 인프라의 세부사항을 몰라도 됩니다. “10GB 읽기/쓰기 저장소 주세요”라고 요청하면 끝입니다.

### PV-PVC 바인딩 규칙

PV와 PVC는 이름으로 매칭되지 않습니다. **조건 기반**으로 매칭됩니다:

| 조건 | 설명 |
| --- | --- |
| `storageClassName` | 같아야 함 |
| `accessModes` | PV가 PVC 요청 모드를 지원해야 함 |
| `capacity` | PV 용량 ≥ PVC 요청 용량 |
| `volumeMode` | Filesystem/Block 일치 |

**특정 PV에 바인딩하고 싶다면:**

```yaml
# 방법 1: volumeName으로 직접 지정
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  volumeName: my-pv  # 특정 PV 이름 직접 지정
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
# 방법 2: selector로 label 매칭
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  selector:
    matchLabels:
      type: my-special-volume  # PV의 label과 매칭
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### Pod에서 PVC 사용하기

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - mountPath: /data
          name: my-storage
  volumes:
    - name: my-storage
      persistentVolumeClaim:
        claimName: my-pvc  # PVC 이름 참조
```

## 볼륨은 어디에 실재하는가?

**“볼륨이 실제로 어디에 있는 거야?”**라는 질문에 답해보겠습니다. 스토리지 타입에 따라 다릅니다.

### Block Storage – 가장 일반적

Block Storage는 네트워크로 연결된 가상 블록 디바이스입니다.

**예시:** AWS EBS, GCP Persistent Disk (Zonal), Azure Managed Disk

![블록 스토리지 마운트 3단계 — CSI Controller가 EBS 볼륨을 노드에 attach(/dev/xvdf), CSI Node Plugin이 마운트, bind mount로 Pod의 /data에 연결](/images/kubernetes-pod-storage-pv-pvc-1/img-03-image-2.png)

**흐름:**

1.  **볼륨은 클라우드 프로바이더의 스토리지 인프라에 실재** (특정 AZ 내)
2.  **워커 노드에 네트워크로 attach** (마치 USB를 꽂듯이, 네트워크로)
3.  **노드의 특정 경로에 마운트** (/dev/xvdf → /var/lib/kubelet/…)
4.  **Pod 컨테이너 내부로 bind mount** (Pod의 /data로 보임)

### 스토리지 타입별 특징

| 타입 | 예시 | AZ 종속 | 다중 노드 attach |
| --- | --- | --- | --- |
| **Block Storage** | AWS EBS, GCP PD (Zonal), Azure Disk | 종속 | 불가 (단일 노드) |
| **Regional Block Storage** | GCP Regional PD, Azure Zone-redundant Disk | 무관 | 불가 |
| **Network File Storage** | AWS EFS, GCP Filestore, Azure Files, NFS | 무관 | **가능** |
| **hostPath** | 노드 로컬 디스크 | 노드 종속 | N/A |
| **emptyDir** | 노드 임시 공간 | Pod 종속 | N/A |

> **Regional Block Storage란?**
> 
> 일부 클라우드 프로바이더는 여러 AZ에 걸쳐 복제되는 Block Storage를 제공합니다. AZ 장애 시에도 데이터가 유지되지만, 여전히 **단일 노드에만 attach** 가능합니다.

### Pod 재시작 시 볼륨은 어떻게 되는가?

**“Pod가 다른 노드로 재시작되면 볼륨은 어떻게 되나요?”**

Block Storage의 경우 (단일 Pod 기준):

```text
[시나리오: Pod 재시작 → 같은 AZ의 다른 노드]

1. Pod-A (Node-1, AZ-a) 삭제
2. CSI Controller: 볼륨을 Node-1에서 detach
3. Scheduler: 새 Pod를 Node-2 (AZ-a)에 스케줄링
4. CSI Controller: 볼륨을 Node-2에 attach
5. CSI Node Plugin: 볼륨을 Pod 경로에 mount
6. Pod-A (Node-2) 시작 → 같은 데이터 유지!
```

**하지만 다른 AZ의 노드로는 갈 수 없습니다:**

```text
[시나리오: Pod 재시작 → 다른 AZ의 노드?]

볼륨이 AZ-a에 존재 → AZ-b 노드에 attach 불가!
→ Scheduler가 자동으로 AZ-a의 노드에만 스케줄링
→ AZ-a에 사용 가능한 노드가 없으면 Pod는 Pending 상태
```

> **Scheduler는 볼륨 위치를 고려합니다**
> 
> CSI 드라이버가 PV를 생성할 때 `spec.nodeAffinity`에 topology 정보(AZ 등)를 기록합니다. Scheduler는 이 정보를 보고 볼륨을 attach할 수 있는 노드에만 Pod를 스케줄링합니다.
> 
> 자세한 내용은 [Node Affinity in PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity) 문서를 참고하세요.

## CSI: 스토리지 플러그인 인터페이스

[네트워크 이해하기 (2)](/kubernetes-network-guide-2-pod-to-pod/)에서 CNI(Container Network Interface)를, [컴퓨팅 이해하기](/kubernetes-computing-pod-lifecycle/)에서 CRI(Container Runtime Interface)를 다뤘습니다. 스토리지에도 동일한 표준 인터페이스가 있습니다.

### Kubernetes의 3대 표준 인터페이스

| 인터페이스 | 풀네임 | 역할 |
| --- | --- | --- |
| **CNI** | Container Network Interface | 네트워크 플러그인 표준 |
| **CRI** | Container Runtime Interface | 컨테이너 런타임 표준 |
| **CSI** | Container Storage Interface | 스토리지 플러그인 표준 |

> **왜 “드라이버”라고 부를까?**
> 
> 하드웨어 드라이버와 같은 개념입니다:
> 
> -   **프린터 드라이버**: OS와 프린터 사이의 표준 인터페이스
> -   **CSI 드라이버**: Kubernetes와 스토리지 시스템 사이의 표준 인터페이스
> 
> OS가 “인쇄해줘”라고 하면 프린터 드라이버가 해당 프린터에 맞게 번역하듯이, Kubernetes가 “볼륨 만들어줘”라고 하면 CSI 드라이버가 해당 스토리지 시스템(EBS, GCP PD 등)에 맞게 API를 호출합니다.

### CSI 드라이버 구조

![CSI 드라이버 구조 — 각 노드의 Node Plugin(DaemonSet)이 Pod 경로에 마운트하고, Controller Plugin이 스토리지 백엔드(EBS·GCP PD·NFS 등)에 볼륨을 생성·attach](/images/kubernetes-pod-storage-pv-pvc-1/img-04-image-3.png)

CSI 드라이버는 두 가지 컴포넌트로 구성됩니다:

| 컴포넌트 | 배포 방식 | 역할 |
| --- | --- | --- |
| **Controller Plugin** | Deployment | 볼륨 생성/삭제, **워커 노드에** attach/detach |
| **Node Plugin** | DaemonSet (모든 노드) | **Pod 경로에** 마운트/언마운트, 포맷 |

### Controller Plugin의 역할

Controller Plugin은 **클러스터 레벨**의 스토리지 작업을 담당합니다:

| 작업 | 언제 호출 | 설명 |
| --- | --- | --- |
| **CreateVolume** | PVC 생성 시 (동적 프로비저닝) | 스토리지 API로 볼륨 생성 (예: AWS EC2 CreateVolume) |
| **DeleteVolume** | PVC 삭제 시 | 스토리지 API로 볼륨 삭제 |
| **ControllerPublishVolume** | Pod 스케줄링 후 | 볼륨을 특정 노드에 attach |
| **ControllerUnpublishVolume** | Pod 삭제 후 | 볼륨을 노드에서 detach |

> **수동 프로비저닝에서도 Controller Plugin이 필요한가?**
> 
> 네! CreateVolume만 안 쓰이고, **attach/detach는 여전히 필요**합니다. 이미 존재하는 볼륨이라도 Pod가 스케줄링된 노드에 붙여야 하니까요.

### Node Plugin의 역할

Node Plugin은 **각 워커 노드**에서 실행됩니다:

| 작업 | 설명 |
| --- | --- |
| **NodeStageVolume** | attach된 디바이스를 포맷하고 노드의 글로벌 경로에 마운트 |
| **NodePublishVolume** | 글로벌 경로를 Pod의 경로로 bind mount |
| **NodeUnpublishVolume** | Pod 경로에서 언마운트 |

**왜 Node Plugin이 필요한가?**

Controller가 “EBS를 EC2에 붙여!”라고 해서 `/dev/xvdf`가 생겼다고 해도, 그걸 **Pod 컨테이너 안에서 `/data`로 보이게** 하려면 마운트 작업이 필요합니다. 이걸 Node Plugin이 담당합니다.

```text
Pod 스케줄링 → Controller: attach → Node: mount → Pod 사용 가능!
```

## StorageClass와 동적 프로비저닝

매번 PV를 수동으로 만드는 건 번거롭습니다. **StorageClass**를 사용하면 PVC 생성 시 PV가 **자동으로 생성**됩니다. 실무에서는 대부분 동적 프로비저닝을 사용합니다.

### 동적 프로비저닝 흐름

![동적 프로비저닝 시퀀스 — PVC 생성 → CSI Controller가 CreateVolume으로 클라우드 볼륨 생성 → PV 자동 생성·바인딩 → ControllerPublishVolume attach → NodePublishVolume 마운트 → Pod 볼륨 사용](/images/kubernetes-pod-storage-pv-pvc-1/img-05-image-4.png)

1.  개발자가 PVC 생성 (StorageClass 지정)
2.  CSI Controller가 PVC 감지
3.  스토리지 백엔드에 볼륨 생성 요청 (예: AWS EBS 생성)
4.  PV 자동 생성 및 PVC와 바인딩
5.  Pod가 PVC 사용

### StorageClass 정의

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com        # CSI 드라이버 이름
parameters:
  type: gp3                          # AWS EBS 타입
  iops: "3000"
  throughput: "125"
reclaimPolicy: Delete               # PVC 삭제 시 PV도 삭제
allowVolumeExpansion: true          # 볼륨 확장 허용
volumeBindingMode: WaitForFirstConsumer  # Pod 스케줄링 후 바인딩
```

| 필드 | 설명 |
| --- | --- |
| `provisioner` | 사용할 CSI 드라이버 |
| `parameters` | 스토리지 타입 등 드라이버별 설정 |
| `reclaimPolicy` | PVC 삭제 시 PV/데이터 처리 방식 |
| `allowVolumeExpansion` | 볼륨 크기 확장 허용 여부 |
| `volumeBindingMode` | PV 바인딩 시점 |

### 동적 프로비저닝 PVC 예시

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-app-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: fast-ssd  # 이 StorageClass가 PV를 자동 생성
```

이 PVC를 생성하면:

1.  Kubernetes가 `fast-ssd` StorageClass를 찾음
2.  CSI 드라이버(ebs.csi.aws.com)가 20GB gp3 EBS 볼륨 생성
3.  해당 EBS에 대응하는 PV 자동 생성
4.  PVC와 PV 바인딩 완료

> **volumeBindingMode: WaitForFirstConsumer**
> 
> 이 옵션은 **PV가 최초 생성될 때**의 바인딩 시점을 제어합니다.
> 
> 기본값인 `Immediate`는 PVC 생성 즉시 볼륨을 생성합니다. **AZ 종속적인 Block Storage** (EBS, GCP PD Zonal 등) 를 사용할 때, 볼륨이 특정 AZ에 먼저 생성되고 Pod가 다른 AZ의 노드에 스케줄링되면 문제가 됩니다.
> 
> ```
> Immediate 모드 + AZ 종속 스토리지:
>   PVC 생성 → 볼륨이 AZ-a에 생성 → Pod가 AZ-b에 스케줄링 → 💥 실패!
> 
> WaitForFirstConsumer 모드:
>   PVC 생성 → (대기) → Pod가 AZ-b에 스케줄링 → 볼륨이 AZ-b에 생성 → ✅ 성공!
> ```
> 
> **NFS, EFS 같은 AZ 무관한 스토리지**는 `Immediate`여도 문제없습니다. 하지만 Block Storage를 사용하는 클라우드 환경에서는 `WaitForFirstConsumer`가 권장됩니다.
> 
> **참고:** Pod 재시작 시에는 이미 PV가 존재하므로 이 옵션은 무관합니다. 재시작 시에는 PV의 `nodeAffinity`를 보고 Scheduler가 적절한 노드를 선택합니다.

### 수동 프로비저닝

동적 프로비저닝이 일반적이지만, 기존 스토리지를 재사용하거나 특수한 설정이 필요할 때는 수동으로 PV를 만들 수 있습니다.

```yaml
# 1. 관리자가 PV 생성
apiVersion: v1
kind: PersistentVolume
metadata:
  name: existing-volume
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""  # 빈 문자열: 특정 StorageClass 없음
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-existing123456  # 이미 존재하는 EBS ID
    fsType: ext4
---
# 2. 개발자가 PVC 생성 (위 PV와 바인딩됨)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: ""  # PV와 동일하게 빈 문자열
```

| 방식 | 흐름 | 사용 사례 |
| --- | --- | --- |
| **동적** | PVC 생성 → StorageClass → PV 자동 생성 | 일반적인 사용 (90%+) |
| **수동** | 관리자가 PV 생성 → 개발자가 PVC 생성 → 바인딩 | 기존 스토리지 재사용, 특수 설정 |

## 마무리

이 글에서는 Kubernetes 스토리지의 핵심 개념과 동작 원리를 살펴봤습니다.

**핵심 개념:**

-   **Kubernetes Volume**: 스토리지 자체가 아닌 “스토리지를 Pod에 연결하는 설정”
-   **spec.volumes\[\]**: 상위 개념이고, emptyDir/hostPath/persistentVolumeClaim 등은 타입
-   **PV**: 클러스터 레벨의 실제 스토리지 자원
-   **PVC**: 개발자의 스토리지 요청서
-   **StorageClass**: 동적 프로비저닝을 위한 템플릿
-   **CSI**: CNI, CRI와 함께하는 스토리지 플러그인 표준 인터페이스

**기억해야 할 것들:**

-   볼륨은 클라우드 네트워크 스토리지에 실재하고, 노드에 attach → Pod에 mount
-   PV-PVC는 이름이 아닌 조건 기반으로 바인딩됨
-   `WaitForFirstConsumer`는 PV 최초 생성 시에만 해당, 재시작은 nodeAffinity로 처리
-   CSI Controller Plugin은 워커 노드에 attach/detach, CSI Node Plugin은 Pod 경로에 mount

다음 글에서는 **AccessModes, Reclaim Policy, StatefulSet 스토리지 관리, 트러블슈팅** 등 실전 활용과 운영에 대해 다룹니다.

## 참고 자료

-   [Kubernetes Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
-   [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
-   [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
-   [Container Storage Interface (CSI)](https://kubernetes.io/blog/2019/01/15/container-storage-interface-ga/)
-   [Node Affinity in PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity)
