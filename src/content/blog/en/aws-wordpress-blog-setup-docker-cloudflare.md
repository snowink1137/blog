---
title: 'Setting Up a WordPress Blog on AWS (feat. Docker, Cloudflare)'
description: 'The full walkthrough of running WordPress on AWS EC2 with Docker Compose and wiring up a domain and HTTPS through Cloudflare — SSH config, Security Groups, and Elastic IP, written for first-time server builders.'
pubDate: '2025-12-06T15:48:02+09:00'
updatedDate: '2026-08-01T19:30:00+09:00'
category: tech
subcategory: 'AWS'
tags: ['aws', 'cloudflare', 'docker', 'wordpress']
---


## Setting Up a WordPress Blog with AWS EC2 and Docker Compose

When you decide to start a personal blog, the first thing to figure out is hosting. I could have gone with a platform like Tistory or Naver Blog, but I wanted an excuse to get more comfortable with AWS, so I built my own server instead. In this post I'll cover installing WordPress on an AWS EC2 instance using Docker Compose.

### Prerequisites

-   An AWS account
-   An EC2 instance (I used a t3.micro with the Ubuntu image)
-   The PEM key file for SSH access

### Setting Up SSH

To connect to an EC2 instance you need the PEM key file. Passing the key with the `-i` option every single time gets tedious, so it's worth setting up an SSH config. You were prompted to download the key when you first created the instance, so you probably have it saved somewhere.

```bash
# Move the PEM file into the .ssh directory
mkdir -p ~/.ssh
mv ~/Downloads/your-key.pem ~/.ssh/
chmod 400 ~/.ssh/your-key.pem

# Edit the SSH config
vim ~/.ssh/config
```

Add the following to the config file. The indentation matters.

```text
Host wordpress
    HostName <EC2-public-IP>  # Once you pin the address with an Elastic IP later, change this to that IP.
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
```

Now you can connect with a simple `ssh wordpress`.

### Installing Docker

The docker package in Ubuntu's default repository is outdated, so install it [the way the official Docker docs describe](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository).

```bash
# Install prerequisite packages
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# To use docker without sudo
sudo usermod -aG docker $USER
```

That last command only takes effect after you log out and reconnect.

### Composing WordPress with Docker Compose

Create a project directory and write a docker-compose.yml file.

```bash
mkdir ~/wordpress && cd ~/wordpress
vim docker-compose.yml
```

I went with the standard WordPress PHP-Apache image, and set up the DB to run on the same instance. If usage grows later, I plan to migrate the data to something like AWS RDS. That said, running on a t3.micro instance (2 vCPUs, 1GB of memory) I actually hit OOM kills during operation, so I added a number of tuning options to the DB command.

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

Start the containers.

```bash
docker compose -p wordpress up -d
```

### Configuring the Security Group

In the AWS console, add HTTP (port 80) to the inbound rules of the EC2 instance's Security Group — otherwise it won't be reachable from the outside.

| Type | Port | Source |
| --- | --- | --- |
| HTTP | 80 | 0.0.0.0/0 |

Once that's done, open the EC2 public IP in a browser and the WordPress installation screen appears. Go through the initial WordPress setup there.

## Registering a Domain and Enabling HTTPS with Cloudflare

Up to this point we've installed WordPress on AWS EC2 with Docker. But accessing the site by IP address is awkward, and there's no HTTPS yet. In this part we'll register a domain on Cloudflare and enable HTTPS for free.

### Comparing Domain Registrars

Here's how the major registrars compare on price for a .com domain.

| Registrar | Annual Price | Notes |
| --- | --- | --- |
| Cloudflare | ~$10.44 | At-cost pricing, free WHOIS protection |
| AWS Route 53 | ~$12 + hosting costs | Convenient AWS integration |
| Gabia | ~₩24,000 | #1 registrar in Korea, Korean-language support |
| GoDaddy | Cheap first year, expensive renewals | Lots of upsells |
| Namecheap | ~$9 (first year) | Intuitive UI |

Cloudflare sells domains at cost, and the renewal price stays the same. Many other registrars are cheap only for the first year, with prices jumping from year two. WHOIS privacy protection and DNSSEC are included for free as well. Even Cloudflare's free plan gives you a CDN, DDoS protection, SSL certificates, and plenty more.

### Registering a Domain on Cloudflare

1.  Go to [cloudflare.com](https://cloudflare.com) and create an account
2.  Left menu **Domain Registration** → **Register Domains**
3.  Search for the domain you want and hit **Purchase**
4.  Enter the owner information (in English) and pay

WHOIS privacy protection is applied automatically — no extra setup needed.

### Setting Up an Elastic IP

The purchased domain needs to point at an IP — but before doing that, it's a good idea to set up an Elastic IP. If you stop and restart an EC2 instance, its public IP can change. Allocating an Elastic IP pins the address in place. You'll also want to update the .ssh config file from earlier to use the Elastic IP.

1.  AWS Console → EC2 → **Elastic IPs**
2.  Click **Allocate Elastic IP address**
3.  Select the new IP → **Actions** → **Associate Elastic IP address**
4.  Choose your instance and associate it

An Elastic IP used to be free while associated with a running EC2 instance, but **since February 2024 AWS charges $0.005/hour (~$3.6/month) for every public IPv4 address, attached or not**. The free tier does include 750 hours of public IPv4 usage per month for your first 12 months, so a single instance is effectively free during that period.

### DNS Setup

After registering the domain, add A records in the DNS menu.

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | @ | EC2 IP address | On |
| A | www | EC2 IP address | On |

With Proxy set to On (the orange cloud), Cloudflare sits in the middle and handles the traffic.

### Enabling HTTPS (Cloudflare Proxy)

With Cloudflare Proxy, you get HTTPS without setting up your own certificate via something like Let’s Encrypt.

```text
[Client] ←── HTTPS ──→ [Cloudflare] ←── HTTP ──→ [EC2]
```

Pick a mode in the **SSL/TLS** menu.

| Mode | Description |
| --- | --- |
| Flexible | HTTPS only between client and Cloudflare |
| Full | HTTPS on both legs, no certificate validation |
| Full (Strict) | HTTPS on both legs, with certificate validation |

For a personal blog, starting with **Flexible** is good enough. If security matters more to you, install Let’s Encrypt on the EC2 instance, put Nginx in front, and go with **Full (Strict)**. I'm not planning to move to a bigger instance yet, so I left mine on Flexible.

## Wrap-up

And with that, we have a working WordPress blog on AWS EC2 using a domain purchased through Cloudflare. It took a bit more effort than the SaaS-hosted WordPress offerings, but I'd say the payoff is a setup with much more freedom. Once traffic grows, switching the EC2 instance type and moving to an external DB like RDS would be the natural next step.
