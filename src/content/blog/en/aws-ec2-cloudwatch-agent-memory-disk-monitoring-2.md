---
title: 'AWS EC2 Monitoring Guide (2) – Memory and Disk Monitoring with the CloudWatch Agent'
description: 'How to collect the memory and disk metrics that EC2 basic monitoring leaves out, using the CloudWatch Agent. Step-by-step coverage from creating the IAM role to installing and configuring the agent, plus its resource overhead on a t3.micro.'
pubDate: '2026-01-06T22:32:45+09:00'
updatedDate: '2026-01-06T22:32:45+09:00'
category: tech
subcategory: 'AWS'
tags: ['aws', 'cloud-watch', 'cloud-watch-agent', 'ec2', 'monitoring']
---

## Where Can I See Memory Usage?

In [Part 1 of this monitoring guide](/en/aws-ec2-monitoring-cloudwatch-guide-1/) I set up EC2 basic monitoring and CloudWatch alarms. But once you actually run a server, the questions you care about most are different:

"How much memory is left? What happens when the disk fills up?"

If you're running WordPress and MySQL in Docker on an instance with only 1GB of memory, like a t3.micro, running out of memory is a very real concern. Yet EC2 basic monitoring **does not provide memory usage or disk capacity at all.**

In this post I'll install the **CloudWatch Agent** and set up monitoring for memory, disk capacity, and even swap memory.

## What Is the CloudWatch Agent?

The CloudWatch Agent is a **program you install inside the EC2 instance**. It collects system information at the OS level and sends it to CloudWatch.

### Basic Monitoring vs CloudWatch Agent

| | Basic monitoring | CloudWatch Agent |
| --- | --- | --- |
| **Installation** | Not needed (automatic) | Manual install required |
| **Collected from** | Hypervisor (AWS infrastructure) | Inside the OS |
| **Memory usage** | ❌ | ✅ |
| **Disk capacity** | ❌ | ✅ |
| **Swap memory** | ❌ | ✅ |
| **Process monitoring** | ❌ | ✅ |
| **Log collection** | ❌ | ✅ |

Basic monitoring collects data at the AWS infrastructure level, so it has no visibility into the OS. The CloudWatch Agent runs inside the instance, reads system information directly from places like `/proc/meminfo` and `/proc/diskstats`, and ships it to CloudWatch.

## Agent Resource Usage on a t3.micro

"Won't installing the agent slow my server down?"

If you're on a small instance like a t3.micro (2 vCPUs, 1GB memory), that's a fair concern. Here's what the actual resource usage looks like:

| Configuration | CPU usage | Memory usage |
| --- | --- | --- |
| Metrics only | 1-5% | ~50-100MB |
| Metrics + logs (absolute paths) | 5-10% | ~100-150MB |
| Metrics + logs with wildcards (`**/*.log`) | 15-40%+ | 200MB+ ⚠️ |

**If you're only collecting metrics, it runs perfectly fine on a t3.micro.** The memory/disk/CPU/swap metric collection covered in this post is lightweight work.

> **💡 Tips for keeping resource usage low**
> 
> -   Set `metrics_collection_interval` to 60 seconds or more (the default is 60)
> -   For log collection, use **absolute paths** instead of wildcards (`*`)
> -   Only collect the metrics you actually need

### Checking the Agent's Resource Usage Yourself

After installing the agent, you can verify how much it actually consumes.

```bash
# Option 1: check with ps
ps aux | grep amazon-cloudwatch-agent | grep -v grep

# Option 2: watch it live in top (press q to quit)
top -p $(pgrep -d',' amazon-cloudwatch)

# Option 3: install htop (easier to read)
sudo apt install htop -y
htop
```

> **💡 About those pgrep options**
> 
> -   `-f`: Linux only stores the first 15 characters of a process name. `amazon-cloudwatch-agent` is longer than 15 characters, so you need `-f` to search the full command line.
> -   `-d','`: prints multiple PIDs separated by commas. `top -p` expects comma-separated PIDs, which is why this is needed. (e.g. `1234,5678`)

In `htop`, press `F4` and filter by `cloudwatch` to see only the agent processes.

> **💡 Mac users**
> 
> On the default Mac keyboard, F4 is mapped to a system function (Launchpad, etc.), so you may need to press `fn + F4`.

> **💡 Seeing multiple processes?**
> 
> By default, htop **shows threads as individual rows**. If you see several rows but the RES (actual memory) and MEM% values are identical, those are threads sharing the same memory — the actual usage is only counted once. Press `H` to hide threads and view at the process level only.

![htop screen — the cwagent process (amazon-cloudwatch-agent) using 11.6% of memory, with total memory at 509M/914M](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-01-image-25.png)

## Prerequisite: Create an IAM Role

For the CloudWatch Agent to send data to CloudWatch, it needs **permissions**. You have to create an IAM role and attach it to the EC2 instance.

### Step 1: Create the IAM Role

1.  Go to the **IAM** service in the AWS console
2.  Click **Roles** in the left menu
3.  Click **Create role**

![IAM role list screen — the 'Create role' button at the top right](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-02-image-17.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

4.  **Trusted entity type**: select AWS service
5.  **Use case**: select EC2
6.  Click **Next**

### Step 2: Attach the Permission Policy

1.  Type `CloudWatchAgent` in the search box
2.  Check **CloudWatchAgentServerPolicy**
3.  Click **Next**

![IAM add permissions screen — searching for 'cloudwatchagent' and selecting the CloudWatchAgentServerPolicy policy](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-03-image-18.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

> **💡 What CloudWatchAgentServerPolicy includes**
> 
> This policy grants permission to write metrics/logs to CloudWatch (`PutMetricData`, `PutLogEvents`) and read EC2 tags (`DescribeTags`). It's the minimum set of permissions the agent needs to run.

### Step 3: Name and Create the Role

1.  **Role name**: `EC2-CloudWatch-Agent-Role` (something easy to recognize)
2.  Click **Create role**

### Step 4: Attach the Role to EC2

1.  Go to the **EC2** service
2.  Select the target instance
3.  Click **Actions** > **Security** > **Modify IAM role**
4.  Select the role you just created
5.  Click **Update IAM role**

![Menu path on an EC2 instance: Actions → Security → 'Modify IAM role'](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-04-image-19.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

Once attached, the role name appears under the **IAM Role** field in the EC2 instance details.

## Installing the CloudWatch Agent (Ubuntu)

Now SSH into the EC2 instance and install the agent. These steps are for Ubuntu.

### Download and Install the Agent Package

```bash
# Download the package
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb

# Install the package
sudo dpkg -i -E ./amazon-cloudwatch-agent.deb
```
![Terminal — output of downloading amazon-cloudwatch-agent.deb (64M) with wget, then installing it with dpkg](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-05-image-20.png)

Once the install completes, the agent files land in `/opt/aws/amazon-cloudwatch-agent/`.

> **💡 Using a different architecture/OS?**
> 
> If you're on an ARM-based instance (Graviton), replace `amd64` with `arm64`. Download links for other operating systems are listed in the [AWS official docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/download-CloudWatch-Agent-on-EC2-Instance-commandline-first.html).

## Building the Configuration File

The agent reads a **configuration file** (config.json) to decide which metrics to collect.

### Two Ways to Configure

**Option 1: Use the configuration wizard** ([AWS docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/create-cloudwatch-agent-configuration-file-wizard.html))

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

You answer interactive questions in the CLI and it generates the config file for you. It runs in the terminal, not a web UI. Convenient, but there are a lot of options, so it takes a while.

**Option 2: Write config.json by hand** ✅ (used in this post) ([AWS docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html)) You write only the settings you need. You can copy-paste it and be done — much faster.

### Writing config.json

Create the config file with:

```bash
sudo vi /opt/aws/amazon-cloudwatch-agent/bin/config.json
```

Paste in the following:

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

> **💡 What if you omit run\_as\_user?**
> 
> If you don't specify `run_as_user`, the CloudWatch Agent runs with the default: **root privileges**. Running as root lets it read most log files — `/var/log/syslog`, `/var/log/auth.log`, Docker logs, and so on — without any extra permission setup. ([See the AWS docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html))

### Configuration Fields Explained

| Field | Description |
| --- | --- |
| `metrics_collection_interval` | Metric collection interval in seconds. 60 recommended |
| `namespace` | The namespace where you'll find the metrics in CloudWatch |
| `append_dimensions` | Dimensions added to each metric. InstanceId distinguishes instances |

### Metrics Being Collected

| Category | Metric | Description |
| --- | --- | --- |
| **mem** | `mem_used_percent` | Memory usage (%) |
| **mem** | `mem_available_percent` | Available memory (%) |
| **disk** | `disk_used_percent` | Disk usage (%) |
| **disk** | `disk_free` | Free disk space (bytes) |
| **cpu** | `cpu_usage_active` | Active CPU usage (%) |
| **cpu** | `cpu_usage_idle` | Idle CPU (%) |
| **swap** | `swap_used_percent` | Swap memory usage (%) |

> **💡 About the disk resources setting**
> 
> `"resources": ["/"]` means monitoring **disk capacity for the root mount point**. If subdirectories like `/var` and `/home` live on the same volume, they're naturally included. This setting doesn't crawl files — it measures capacity per mount point, just like the `df -h` command.
> 
> If you've attached an additional EBS volume mounted at `/mnt/data`, you need to specify `"resources": ["/", "/mnt/data"]` for that volume to be monitored too. Setting `"resources": ["*"]` collects every mount point, but the metric count grows and so can your bill.

> **💡 About totalcpu**
> 
> `"totalcpu": true` collects the average across all CPUs. Setting it to `false` collects each core separately, which increases the metric count.

## Starting the Agent and Checking Its Status

### Start the Agent

Apply the config file and start the agent.

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json \
  -s
```

What each option means:

-   `-a fetch-config`: fetch and apply the config file
-   `-m ec2`: run in EC2 mode
-   `-c file:path`: path to the config file
-   `-s`: start the agent after applying

### Check the Agent Status

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a status
```

If it's running normally, you'll see output like this:

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
![Terminal — result of amazon-cloudwatch-agent-ctl status, showing status running and configured](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-06-image-21.png)

If you see `"status": "running"`, you're good.

> **💡 Restart/stop commands**
> 
> ```bash
> # Restart
> sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a restart
> 
> # Stop
> sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a stop
> ```

## Finding the New Metrics in CloudWatch

Once the agent is running, the metrics show up in CloudWatch after a minute or two.

### Find the CWAgent Namespace

1.  Go to the **CloudWatch** service in the AWS console
2.  Click **Metrics** > **All metrics** in the left menu
3.  Under **Custom namespaces** at the bottom, select **CWAgent**

![CloudWatch metrics screen — the newly created CWAgent card under 'Custom namespaces'](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-07-image-22.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

> **⚠️ Don't see CWAgent?**
> 
> -   Wait 2-3 minutes after starting the agent
> -   Verify the agent status is `running`
> -   Verify the IAM role is properly attached to the EC2 instance

### Check the Memory/Disk Metrics

Click into the **CWAgent** namespace and you'll see several groups. That's because different metric types come with different dimensions.

| Dimension group | Metrics included |
| --- | --- |
| **InstanceId** | mem\_used\_percent, mem\_available\_percent, swap\_used\_percent |
| **InstanceId, cpu** | cpu\_usage\_active, cpu\_usage\_idle |
| **InstanceId, device, fstype, path** | disk\_used\_percent, disk\_free |

Click into each group and check the metrics you want to see them on the graph at the top.

![CloudWatch graph — disk_used_percent and mem_used_percent metrics collected by CWAgent (around 49.5%)](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-08-image-23.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

At last — **memory usage** and **disk capacity**, the metrics you can't see anywhere in the EC2 console, are now visible in CloudWatch!

## Creating a Memory Alarm

Just like the CPU alarm in [Part 1](/en/aws-ec2-monitoring-cloudwatch-guide-1/), let's set up a memory alarm.

### mem\_used\_percent vs mem\_available\_percent

Before creating the alarm, you need to decide which metric to base it on.

| Metric | Meaning | buff/cache handling |
| --- | --- | --- |
| **mem\_used\_percent** | Percentage of memory currently occupied | Included (even reclaimable memory counts as "used") |
| **mem\_available\_percent** | Percentage of memory usable right now | Excluded (reclaimed on demand, so it counts as "available") |

Linux puts spare memory to work as buff/cache. That region is **automatically released** whenever an application requests memory. So even when `mem_used_percent` reads 80%, things are often perfectly fine.

**When `mem_available_percent` drops, it means "the memory you can actually use is running out"** — so it detects real memory pressure much more accurately. On small-memory instances like a t3.micro, this metric is the more realistic choice.

### Create the Alarm

1.  CloudWatch > **Alarms** > **All alarms** > **Create alarm**
2.  **Select metric** > **CWAgent** > **InstanceId**
3.  Select `mem_available_percent` > click **Select metric**

![Memory alarm creation screen — the CWAgent mem_available_percent metric with a 'Lower than 20' condition and datapoints set to 2 out of 3](/images/aws-ec2-cloudwatch-agent-memory-disk-monitoring-2/img-09-image-24.png)

*Console shown in Korean — the layout and menu positions are identical in the English console.*

### Configure the Conditions

| Setting | Recommended value | Description |
| --- | --- | --- |
| **Threshold type** | Static | Compare against a fixed value |
| **Condition** | Lower than | Alarm when available memory drops **below** the threshold |
| **Threshold** | 20 | When available memory falls below 20% |
| **Datapoints to alarm** | 2/3 | Alarm when 2 out of 3 datapoints breach (reduces noise) |

> **⚠️ Watch the condition direction**
> 
> `mem_used_percent` is "dangerous when high," so you'd use **Greater than** — but `mem_available_percent` is "dangerous when low," so you use **Lower than**. Set the direction backwards and the alarm won't work properly, so be careful.

### Configure Notifications

Reuse the SNS topic you created in Part 1, or create a new one.

1.  **Alarm state trigger**: select "In alarm"
2.  **SNS topic**: select an existing topic or create a new one
3.  **Alarm name**: `EC2-Memory-Low-Available-Alert`
4.  Click **Create alarm**

## A Note on Cost

The metrics collected by the CloudWatch Agent are classified as **custom metrics**, which can incur charges.

### Free Tier Limits

| Item | Free allowance |
| --- | --- |
| Custom metrics | **10/month** |
| Alarms | 10 |

### Metric Count for This Post's Configuration

| Metric | Count |
| --- | --- |
| mem\_used\_percent | 1 |
| mem\_available\_percent | 1 |
| disk\_used\_percent | 1 |
| disk\_free | 1 |
| cpu\_usage\_active | 1 |
| cpu\_usage\_idle | 1 |
| swap\_used\_percent | 1 |
| **Total** | **7** |

**7 metrics stays within the Free Tier limit of 10.** You can use this setup at no extra cost.

> **⚠️ When charges do apply**
> 
> -   11 or more metrics: $0.30/metric/month for the overage
> -   Agent installed on multiple instances: metrics are counted per instance
> -   Collecting all disks with `resources: ["*"]`: metric count grows per mount point

## Troubleshooting

### The Agent Won't Start

**1\. Check for permission problems**

```bash
# Check the agent log
sudo cat /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

If you see an `AccessDenied` error, the IAM role isn't attached properly.

**2\. Verify the IAM role**

Recent EC2 instances use the security-hardened **IMDSv2**, which requires a token.

```bash
# Get a token
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

# Check the IAM role using the token
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

If a role name is printed, you're fine. A 404 error means no role is attached.

> **💡 What is 169.254.169.254?**
> 
> It's the address of the EC2 **Instance Metadata Service (IMDS)**. From any EC2 instance, hitting this IP lets the instance look up information about itself (instance ID, IAM role, region, and so on). It's a special link-local address AWS provides internally — the CloudWatch Agent uses it to fetch instance information too.
> 
> It used to be reachable with a plain curl (IMDSv1), but due to security vulnerabilities, recent instances default to the token-based **IMDSv2**. ([AWS docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html))

### The CWAgent Namespace Doesn't Appear

1.  Check the agent status: make sure `status` is `running`
2.  Check the config file syntax: a JSON syntax error stops the agent from collecting metrics
3.  Check internet connectivity: the agent must be able to reach the CloudWatch endpoint

### Validate the Config File Syntax

```bash
# Validate JSON syntax
cat /opt/aws/amazon-cloudwatch-agent/bin/config.json | python3 -m json.tool
```

If the JSON prints back formatted without errors, the syntax is fine.

## Wrap-up

A quick recap of what this post covered.

The **CloudWatch Agent** is a program installed inside EC2 that collects what basic monitoring doesn't provide: memory usage, disk capacity, swap memory, and more.

The **installation process** goes: create an IAM role → attach it to EC2 → install the agent package → write the config file → start the agent.

**Resource usage** with metrics-only collection is around 1-5% CPU and 50-100MB of memory — perfectly manageable even on a t3.micro.

**Cost** stays within the Free Tier with this post's configuration (7 metrics), so there are no extra charges.

**Viewing the metrics** happens in CloudWatch > Metrics > the CWAgent namespace, and you can set alarms on them exactly like you do with basic monitoring.

## References

-   [Installing and running the CloudWatch agent on your servers – AWS official docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Agent-commandline-fleet.html)
-   [Metrics collected by the CloudWatch agent – AWS official docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-collected-by-CloudWatch-agent.html)
-   [Troubleshooting high CPU from the CloudWatch agent – AWS re:Post](https://repost.aws/knowledge-center/cloudwatch-agent-high-cpu)
-   [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
