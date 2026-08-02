---
title: 'Understanding Kubernetes Storage (2): Using and Managing PV/PVC in Practice'
description: 'What the three AccessModes really mean, the Deployment + RWO PVC trap, the PV lifecycle and Reclaim Policy — the problems you actually run into when operating PV/PVC.'
pubDate: '2026-01-12T19:01:00+09:00'
updatedDate: '2026-01-12T19:01:00+09:00'
category: tech
subcategory: 'Kubernetes'
tags: ['kubernetes', 'pv', 'pvc', 'storage']
---

## Introduction

In the [previous post](/en/kubernetes-pod-storage-pv-pvc-1/) I covered the concept of Kubernetes volumes and how PV, PVC, StorageClass, and CSI drivers work.

This post focuses on **practical usage and operations**:

-   Can a Volume attached to one Pod be used by another Pod?
-   What does it mean when a volume gets "dropped"?
-   What happens to the data when I delete a PVC?
-   How is storage managed in a StatefulSet?
-   Can I grow a volume while it's in use?

## AccessModes: Who Can Access It, and How?

The answer to **"Can other Pods use this volume too?"** comes down to the **AccessMode**.

### The Three AccessModes

| AccessMode | Abbreviation | Meaning |
| --- | --- | --- |
| **ReadWriteOnce** | RWO | Read/write from a single node |
| **ReadOnlyMany** | ROX | Read-only from multiple nodes |
| **ReadWriteMany** | RWX | Read/write from multiple nodes |

### Supported AccessModes by Storage Type

| Storage | RWO | ROX | RWX |
| --- | --- | --- | --- |
| AWS EBS | ✅ | ❌ | ❌ |
| GCP PD | ✅ | ✅ | ❌ |
| Azure Disk | ✅ | ❌ | ❌ |
| NFS | ✅ | ✅ | ✅ |
| AWS EFS | ✅ | ✅ | ✅ |
| CephFS | ✅ | ✅ | ✅ |

> **RWO means "single node", not "single Pod"**
> 
> ReadWriteOnce means the volume can only be mounted on **one node**. Multiple Pods on the same node **can** mount the same RWO volume.
> 
> In practice, though, it's almost always used by a single Pod:
> 
> -   Multiple Pods writing to the same volume can cause **file conflicts**
> -   Apps that need an exclusive lock, like databases, will error out
> -   So for practical purposes, think of **RWO + PVC = dedicated to a single Pod**

### The Problem with Deployment + RWO PVC

**"What happens if I set replicas: 3 on a Deployment?"**

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
            claimName: my-pvc  # RWO volume
```

**The constraint:** an RWO volume can only be **mounted on a single node**. So if the 3 Pods get scheduled onto different nodes, only the first Pod mounts the volume and the rest fail.

| Situation | Result |
| --- | --- |
| All 3 Pods on the same node | All can mount (RWO limits by **node**) |
| 3 Pods on different nodes | Only 1 succeeds, the rest hit a **Multi-Attach error** |

> **The scheduler only considers the AZ when placing Pods — not the RWO constraint tied to a node**
> 
> The scheduler looks at the PV's `nodeAffinity` and schedules Pods **only onto nodes in the AZ where the volume lives**. For example, if an EBS volume is in AZ-a, Pods are placed only on nodes in AZ-a.
> 
> But what if there are **multiple nodes within the same AZ**? The scheduler is free to pick any of them. Even if the RWO volume is already attached to Node-1, the scheduler can happily schedule a Pod onto Node-2.
> 
> ```text
> AZ-a has Node-1, Node-2, Node-3
> The RWO volume is attached to Node-1
> 
> Pod-1 → scheduled to Node-1 → attach succeeds ✅
> Pod-2 → scheduled to Node-2 → attach attempted → Multi-Attach error ❌
> Pod-3 → scheduled to Node-3 → attach attempted → Multi-Attach error ❌
> ```
> 
> The error occurs because **the CSI driver rejects the request at attach time**.

**Solutions:**

| Approach | Description |
| --- | --- |
| **RWX storage** | NFS, EFS, etc. — mountable from multiple nodes simultaneously |
| **StatefulSet** | Automatically creates a separate PVC per Pod |
| **replicas: 1** | With RWO + Deployment, only a single replica is safe |

### Sharing a Volume Across Multiple Pods

To share the same data across multiple Pods, you need storage that supports **ReadWriteMany** (RWX).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-pvc
spec:
  accessModes:
    - ReadWriteMany  # readable/writable from multiple nodes
  resources:
    requests:
      storage: 10Gi
  storageClassName: efs-storage  # NFS/EFS-backed StorageClass
```

Use cases that call for RWX:

-   Static files shared by multiple web servers
-   Shared ML training data
-   Centralized log storage

## The PV Lifecycle and Reclaim Policy

Ever heard someone say **"the volume got dropped"**? That expression is tied to the PV lifecycle.

### PVC and PV Are Independent of Pods

Even if you edit a Deployment and remove its volumes section, the PVC and PV are **independent resources** and stay right where they are.

```yaml
# Before: PVC mounted
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-pvc

# After: even with the volumes section removed
# → the PVC still exists
# → the PV still exists
# → the PVC-PV binding is intact
```

To delete a PVC, you have to do it explicitly with `kubectl delete pvc my-pvc`.

### PV States (Phase)

![PersistentVolume state transition diagram — a PV starts as Available after creation, becomes Bound when a PVC binds to it, and on PVC deletion is either deleted (Delete policy) or moved to Released (Retain policy); removing claimRef returns a Released PV to Available for reuse](/images/kubernetes-pod-storage-pv-pvc-2/img-01-image-5.png)

*Diagram labels are in Korean — the transitions read: "create PV" → Available ("usable, waiting for a PVC to bind"), "bind to PVC" → Bound ("attached to a PVC, in use by a Pod"), "delete PVC (Delete policy)" → PV and storage deleted, "delete PVC (Retain policy)" → Released ("old data remains, no automatic reuse"), and "remove claimRef (manual step)" → back to Available.*

| State | Meaning |
| --- | --- |
| **Available** | Not yet bound to a PVC, ready for use |
| **Bound** | Bound to a PVC, in use |
| **Released** | The bound PVC was deleted, not yet reusable |
| **Failed** | Automatic reclamation failed |

When people say a volume got "dropped", they usually mean **the PVC was deleted and the PV moved to the Released state**.

### Reclaim Policy: What Happens to the PV After PVC Deletion

When you delete a PVC, what happens to the bound PV? The **Reclaim Policy** decides.

| Policy | Behavior | Data |
| --- | --- | --- |
| **Retain** | PV kept, transitions to Released | Preserved |
| **Delete** | PV and the actual storage deleted **immediately** | Deleted |

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: retain-storage
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain  # keep the PV and data even after PVC deletion
```

> **The default Reclaim Policy for dynamic provisioning is Delete**
> 
> Deleting a PVC that holds important data can mean **the data is gone for good**! Deletion happens **immediately, with no grace period**, so there's no recovering it. In production, use the `Retain` policy or take a backup before deleting.

### Changing the Reclaim Policy

**Option 1: create a new StorageClass** (recommended)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-retain  # new StorageClass with the Retain policy
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
parameters:
  type: gp3
```

**Option 2: patch the reclaimPolicy of an existing PV**

```bash
kubectl patch pv my-pv -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

The reclaimPolicy is consulted **at the moment the PVC is deleted**. So changing the policy after the PV was created still takes effect. If a PV holds important data, switch it to Retain before the PVC ever gets deleted.

> **Who creates StorageClasses?**
> 
> Typically the **cluster administrator** sets them up. Developers can create them too if they have the permissions, but usually you work with the StorageClasses your admin provides. If you need a particular reclaimPolicy, ask your admin — or manually change the policy on an already-created PV.

### Reusing a PV in the Released State

A PV preserved by the `Retain` policy **will not automatically bind to a new PVC**. The old data is still on it, so this is intentionally blocked for security reasons.

Recreating a PVC with the exact same name won't rebind it either. To reuse the PV:

1.  Back up the data (if needed)
2.  Delete the PV's `spec.claimRef` field
3.  The PV's state changes to `Available`
4.  A new PVC can now bind to it

```bash
# remove claimRef → transitions to Available
kubectl patch pv my-pv -p '{"spec":{"claimRef": null}}'
```

> **Recovering from a "dropped" volume**
> 
> If a PVC was deleted by mistake and the PV went into the Released state:
> 
> 1.  Check the PV's state with `kubectl get pv`
> 2.  If the Reclaim Policy is `Retain`, the data is safe
> 3.  Remove the `claimRef` to move the PV to Available
> 4.  Create a new PVC and it will bind
> 
> If the Reclaim Policy was `Delete`… the data has most likely already been deleted.

## StatefulSet and Storage

I briefly introduced StatefulSet in [Understanding Kubernetes Computing (1)](/en/kubernetes-computing-pod-lifecycle/). StatefulSet is for **stateful applications** (databases, Kafka, and the like), and it has a deep relationship with storage.

### StatefulSet's volumeClaimTemplates

A Deployment references a PVC directly, but a StatefulSet uses **volumeClaimTemplates** to **automatically create a separate PVC for each Pod**.

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
  volumeClaimTemplates:  # auto-creates a PVC per Pod
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 10Gi
```

Creating this StatefulSet gives you:

```text
Pod name         → PVC name
postgres-0       → data-postgres-0
postgres-1       → data-postgres-1
postgres-2       → data-postgres-2
```

### StatefulSet Storage Characteristics

| Behavior | Deployment | StatefulSet |
| --- | --- | --- |
| Pod names | Random (my-app-7d8f…) | Fixed ordinals (my-app-0, 1, 2) |
| PVC | Shared, or created manually | Auto-created per Pod |
| Pod restart | New Pod may end up on a different PVC | Same-ordinal Pod reuses the same PVC |
| Scale down | Depends on how you manage the PVCs | PVCs are not deleted (default) |

### Storage on Pod Restart

```text
postgres-0 terminates → postgres-0 recreated → rebinds to data-postgres-0
```

When a StatefulSet Pod restarts, **the Pod with the same name reconnects to the same PVC**. The data stays intact.

### Storage on Scale Up/Down

**Scale up (replicas: 3 → 5):**

```text
Existing: postgres-0, postgres-1, postgres-2
Added:    postgres-3 created → data-postgres-3 PVC auto-created
          postgres-4 created → data-postgres-4 PVC auto-created
```

**Scale down (replicas: 5 → 3):**

```text
Deleted: postgres-4 deleted (Pod only)
         postgres-3 deleted (Pod only)
PVCs:    data-postgres-3 and data-postgres-4 remain!
```

> **Scaling down does not delete PVCs**
> 
> This is **a deliberate design choice for data protection**. If you scale back up, the existing PVCs are reused.
> 
> To delete the PVCs, you have to do it manually:
> 
> ```bash
> kubectl delete pvc data-postgres-3 data-postgres-4
> ```

### Storage on StatefulSet Deletion

```bash
kubectl delete statefulset postgres
```

Deleting a StatefulSet **does not delete its PVCs**. To clean up completely:

```bash
# delete the StatefulSet
kubectl delete statefulset postgres

# delete the PVCs too (permanently deletes the data)
kubectl delete pvc -l app=postgres
```

### A Caution About Scaling Down Distributed Databases

StatefulSet preserves PVCs, but **distributed databases require data handling at the application level**.

**Plain StatefulSet (e.g. a simple web app):**

```text
replicas: 5 → 3
Pod-4 and Pod-3 deleted → PVCs remain → no data loss
```

**Distributed DB (e.g. Cassandra, a MongoDB replica set):**

```text
replicas: 5 → 3
Problem: what about the data shards Pod-3 and Pod-4 were holding?
→ If the data is replicated to other nodes, OK
→ If not, data loss!
```

| Database | Required steps before scaling down |
| --- | --- |
| **Cassandra** | Migrate data off with `nodetool decommission` |
| **MongoDB** | Remove the member from the replica set |
| **PostgreSQL (Patroni)** | Remove only non-leader replicas |
| **Kafka** | Run a partition reassignment |

> **Bottom line: don't casually shrink StatefulSet replicas**
> 
> The StatefulSet itself preserves PVCs, but in a distributed system, **data rebalancing at the app level must come first**. Check your database's documentation and follow the safe procedure.

### How Do You Keep Data Safe?

| Approach | Setting |
| --- | --- |
| **Reclaim Policy: Retain** | PV/data preserved even if the PVC is deleted |
| **Scale down** | PVCs kept by default (distributed DBs need app-level handling) |
| **StatefulSet deletion** | PVCs kept by default |
| **Backup before PVC deletion** | Use a backup tool like Velero |

## Volume Expansion: Growing a Volume

**"Can I grow a volume while it's live?"** Yes, you can!

### Requirements for Volume Expansion

1.  **The StorageClass has `allowVolumeExpansion: true`**
2.  **The CSI driver supports volume expansion**
3.  Only **dynamically provisioned PVCs** qualify

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: expandable
provisioner: ebs.csi.aws.com
allowVolumeExpansion: true  # required for expansion
```

### How to Expand a Volume

Just edit the PVC's `spec.resources.requests.storage`.

```bash
# check the existing PVC
kubectl get pvc my-pvc
# NAME     STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Bound    pvc-xxx   10Gi       RWO            expandable

# patch the PVC size
kubectl patch pvc my-pvc -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'

# verify after expansion
kubectl get pvc my-pvc
# NAME     STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Bound    pvc-xxx   20Gi       RWO            expandable
```

### Online vs Offline Expansion

| Expansion type | Description | Support |
| --- | --- | --- |
| **Online** | Expand while the Pod is running (no downtime) | Most modern CSI drivers |
| **Offline** | Requires a Pod restart | Some legacy drivers |

Volume expansion became a Stable feature in Kubernetes 1.24, and most CSI drivers support **online expansion**.

> **Volume shrinking is not a thing!**
> 
> Kubernetes only supports volume **expansion**. Once you grow a volume, you can't shrink it back. The recommended strategy: start with a reasonable size and grow as needed.

## Block Storage vs Object Storage

Since both carry the word "storage", you might wonder: **"how is this different from hooking up something like S3 to a Pod?"**

### The Two Storage Types

| | Block storage | Object storage |
| --- | --- | --- |
| **Examples** | AWS EBS, GCP PD, Azure Disk | AWS S3, GCS, MinIO |
| **Access method** | Filesystem mount (OS level) | API calls (application level) |
| **Pod connection** | Mounted via PV/PVC | Accessed via SDK/API |
| **Data structure** | File/folder hierarchy | Key-value (objects) |
| **Use cases** | DBs, logs, general file storage | Images, backups, static files |

### PV/PVC Is for Block Storage

Kubernetes' PV/PVC system is built for **block storage**. A disk gets mounted into the Pod and used like a filesystem.

```yaml
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: my-pvc  # block storage like EBS
```

### S3 Is Accessed Directly from the Application

Object storage like S3 is not mounted via PV/PVC. Application code accesses it directly through an SDK.

```yaml
# inject env vars/secrets for S3 access
env:
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: aws-secret
        key: access-key
  - name: S3_BUCKET
    value: my-app-bucket
```

> **What about configuring S3-compatible storage in an app like Langfuse?**
> 
> That's **application-level** configuration. You pass the S3 connection details (endpoint, access key, etc.) to the Pod as environment variables, and the app stores data through the S3 API.
> 
> It's a separate concept from PV/PVC, and the two can be used together:
> 
> -   **PVC**: DB data storage (block storage)
> -   **S3**: uploaded file storage (object storage)

## Troubleshooting

### When a PVC Is Stuck in Pending

```bash
kubectl get pvc
# NAME     STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS
# my-pvc   Pending                                       fast-ssd
```

**Things to check:**

| Cause | How to check | Fix |
| --- | --- | --- |
| StorageClass missing | `kubectl get sc` | Create the StorageClass |
| CSI driver not installed | `kubectl get pods -n kube-system` | Install the CSI driver |
| Out of capacity | Check quotas in the cloud console | Request a quota increase |
| AZ mismatch | Check `volumeBindingMode` | Use `WaitForFirstConsumer` |

```bash
# check the detailed cause
kubectl describe pvc my-pvc
# look for error messages in the Events section
```

### Checking Volume Attach/Detach History

```bash
# check PV events
kubectl describe pv my-pv

# check Pod events (volume-related)
kubectl describe pod my-pod | grep -A 10 Events

# check CSI driver logs
kubectl logs -n kube-system -l app=ebs-csi-controller
```

### Common Problems

| Problem | Symptom | Fix |
| --- | --- | --- |
| Multi-Attach error | RWO volume used from multiple nodes | Delete the old Pod, or use RWX storage |
| Volume mount timeout | Pod stuck in ContainerCreating | Check CSI driver status, check node status |
| Filesystem resize failure | Capacity doesn't grow after expansion | Restart the Pod (for offline expansion) |
| Released PV can't be reused | PV never becomes Available after PVC deletion | Manually remove the claimRef |

## Wrap-up

In this post we looked at the practical use and operation of PV/PVC.

**Key takeaways:**

-   **AccessMode**: RWO is effectively single-Pod in practice; sharing across Pods requires RWX
-   **Reclaim Policy**: Delete removes storage immediately; use Retain in production
-   **Released PV**: no automatic rebinding — you must remove the claimRef
-   **StatefulSet**: volumeClaimTemplates auto-creates a PVC per Pod; PVCs survive scale-downs
-   **Distributed DB scale-down**: app-level data rebalancing must come first
-   **Volume Expansion**: growing only — no shrinking

**Troubleshooting keywords:**

-   PVC Pending → check the StorageClass, CSI driver, and AZ
-   Multi-Attach error → an RWO volume used from multiple nodes
-   Volume mount timeout → check the CSI driver and node status

**And with that, the Understanding Kubernetes series is complete:**

| Series | Core question |
| --- | --- |
| [Understanding Networking (1)](/en/kubernetes-network-guide-1-external-to-pod/) | How does an external request reach a Pod? |
| [Understanding Networking (2)](/en/kubernetes-network-guide-2-pod-to-pod/) | How do Pods talk to each other? |
| [Understanding Computing (1)](/en/kubernetes-computing-pod-lifecycle/) | How are Pods placed and run? |
| [Understanding Storage (1)](/en/kubernetes-pod-storage-pv-pvc-1/) | How does a Pod use volumes? |
| [Understanding Storage (2)](/en/kubernetes-pod-storage-pv-pvc-2/) | How do you manage PV/PVC? |

## References

-   [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
-   [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
-   [Volume Expansion](https://kubernetes.io/blog/2022/05/05/volume-expansion-ga/)
-   [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
-   [Node Affinity in PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity)
