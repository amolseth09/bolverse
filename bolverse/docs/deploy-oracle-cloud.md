# Deploying the Bolverse backend on Oracle Cloud Always Free

This guide puts the Bolverse API, its PostgreSQL database, the web app and the admin dashboard on a single
Always Free Oracle Cloud virtual machine, with HTTPS from Let's Encrypt. The AI models stay on Google Colab
for now, because they are too heavy for the free machine.

> **Database choice.** The brief asked for Oracle Autonomous Database. On 21 Oct 2026 you chose
> PostgreSQL on the same VM: it's simpler, it's what the code is tested on (the test suites run against
> both PostgreSQL 16 and SQLite), and it needs no wallet. The appendix at the end covers Autonomous
> Database if you want it later.

```
 phones / browsers ──HTTPS──▶ Nginx (TLS, Let's Encrypt) on the Oracle VM
                               ├─ app.example.com  → web app (static files)
                               └─ api.example.com  → Bolverse API (uvicorn, systemd) ──▶ PostgreSQL (same VM, local only)
                                                      │  /dashboard → admin dashboard
                                                      └─HTTPS──▶ AI worker on Colab (ngrok)  [speech, translation, voices]
```

## 0. What Always Free includes (checked 21 October 2026)

From Oracle's official Always Free resources page
(https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm), in your **home region** only:

| Resource | Always Free limit |
|---|---|
| Ampere A1 (Arm) compute | **1,500 OCPU hours and 9,000 GB hours a month, which equals 2 OCPUs and 12 GB of memory in total**. Earlier guides say 4 OCPUs / 24 GB; Oracle halved this in 2026. |
| AMD micro VMs (VM.Standard.E2.1.Micro) | Up to 2, each 1/8 OCPU and 1 GB of memory |
| Block storage | 200 GB in total for boot and block volumes, plus 5 volume backups |
| Autonomous AI Database | 2 databases, each with 1 OCPU and 20 GB |
| Outbound data | 10 TB a month |
| Load balancers | 1 flexible load balancer (10 Mbps) and 1 network load balancer |
| Object Storage | 20 GB, and 50,000 API requests a month (after the trial) |

Two rules matter for cost and uptime:

- **Going over the A1 limit:** if your A1 instances add up to more than 2 OCPUs / 12 GB, then after the
  trial they are **disabled, and deleted after 30 days**, unless you upgrade to a paid account. On a paid
  account the excess is billed.
- **Idle reclamation:** Oracle may reclaim an Always Free instance that is idle for 7 days. Idle means
  95th-percentile CPU under 20%, network under 20%, **and** memory under 20% (A1 only). A server with real
  users is not idle; a test server nobody uses can be reclaimed.

New accounts also get US$300 of trial credits for 30 days. After that, Always Free resources keep running.

## 1. Create the account and protect yourself from charges

1. **Sign up** at https://www.oracle.com/cloud/free/.
   - Choose your **home region** carefully, because Always Free resources only exist there. India South
     (Hyderabad) or India West (Mumbai) is closest to Indian users.
   - A card is needed to verify your identity; it is not charged for Always Free use.
2. **Set a budget alert at once.** Go to **Billing & Cost Management → Budgets → Create Budget**, choose
   the root compartment, set the amount to **₹100 (or US$1)**, and add an alert at 1% of actual spend to
   your email. Any charge then emails you the same day.
3. **Leave the account on the free tier.** Don't upgrade to Pay As You Go unless you mean to pay; once
   upgraded, anything beyond Always Free is billed.

## 2. Network: VCN and firewall rules

1. Go to **Networking → Virtual Cloud Networks → Start VCN Wizard → "Create VCN with Internet
   Connectivity"**. Name it `bolverse-vcn` and keep the defaults.
2. Open the public subnet's **Default Security List** and add these ingress rules (source `0.0.0.0/0`,
   TCP):
   - port **80** (needed for Let's Encrypt and the redirect to HTTPS)
   - port **443**
   - Port 22 (SSH) is already open. To restrict it, change its source to your own IP: `<your-ip>/32`.
3. Don't open 5432 (PostgreSQL) or 8000 (the API). They stay private to the VM.

## 3. Create the virtual machine

1. Go to **Compute → Instances → Create instance**.
2. **Image:** Canonical **Ubuntu 24.04**.
3. **Shape:** Ampere → **VM.Standard.A1.Flex**, with **2 OCPUs and 12 GB** of memory. Check that it says
   "Always Free-eligible".
   - If you see "Out of host capacity", try another availability domain or try again later.
4. **Networking:** `bolverse-vcn`, public subnet, **Assign a public IPv4 address**.
5. **SSH keys:** upload your public key, or download the generated pair and keep it safe.
6. **Boot volume:** 100 GB. That's within the free 200 GB and leaves room for backups.
7. Click **Create**, then note the public IP.

## 4. Domain names

Buy a domain from any registrar (GoDaddy, Namecheap, Hostinger, Cloudflare and so on). In its DNS
settings, create two **A records** pointing to the VM's public IP:

```
api.example.com  →  <public IP>
app.example.com  →  <public IP>
```

Changes usually take effect within minutes, sometimes a few hours. Check with `nslookup api.example.com`.

## 5. Prepare the server

```bash
ssh ubuntu@<public IP>

sudo apt update && sudo apt -y upgrade
sudo apt -y install python3-venv python3-dev build-essential postgresql nginx certbot python3-certbot-nginx \
                    git unzip iptables-persistent

# Oracle's Ubuntu images block everything except SSH with iptables, as well as the security list.
# Open 80 and 443 here too, and keep the rules across reboots.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

sudo timedatectl set-timezone Asia/Kolkata
```

## 6. PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER bolverse WITH PASSWORD 'CHANGE-ME-long-random';
CREATE DATABASE bolverse OWNER bolverse;
SQL
```

PostgreSQL on Ubuntu listens on `localhost` only by default. Leave it that way.

## 7. Install Bolverse

```bash
sudo adduser --system --group --home /opt/bolverse bolverse
# From your PC: scp bolverse.zip ubuntu@<public IP>:/tmp/
sudo unzip -q /tmp/bolverse.zip -d /opt/bolverse/          # gives /opt/bolverse/bolverse/...
sudo chown -R bolverse:bolverse /opt/bolverse
sudo -u bolverse python3 -m venv /opt/bolverse/venv
sudo -u bolverse /opt/bolverse/venv/bin/pip install -U pip
sudo -u bolverse /opt/bolverse/venv/bin/pip install -r /opt/bolverse/bolverse/backend/requirements-api.txt
```

`requirements-api.txt` is the API only: no PyTorch and no models. The AI runs on Colab (section 14).

## 8. Environment variables and secrets

Secrets live in one root-owned file that only the service can read. They are never in the code or in git.

```bash
sudo mkdir -p /etc/bolverse
sudo touch /etc/bolverse/bolverse.env
sudo chown root:bolverse /etc/bolverse/bolverse.env
sudo chmod 640 /etc/bolverse/bolverse.env
python3 -c "import secrets;print(secrets.token_hex(32))"                    # → BOLVERSE_SECRET_KEY
python3 -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"  # → BOLVERSE_DATA_KEY
sudo nano /etc/bolverse/bolverse.env
```

```ini
APP_ENV=production
BOLVERSE_DATABASE_URL=postgresql+psycopg://bolverse:CHANGE-ME-long-random@localhost:5432/bolverse
BOLVERSE_SECRET_KEY=<64 hex characters>
BOLVERSE_DATA_KEY=<44 base64 characters>
BOLVERSE_PUBLIC_BASE_URL=https://api.example.com
BOLVERSE_CORS_ORIGINS=https://app.example.com
BOLVERSE_DASHBOARD_DIR=/opt/bolverse/bolverse/backend/static/dashboard
BOLVERSE_DATA_DIR=/var/lib/bolverse

# First dashboard owner (created on first start if there are no admins)
BOLVERSE_ADMIN_EMAIL=you@example.com
BOLVERSE_ADMIN_PASSWORD=<a strong password; change it after first login>

# SMS: see docs/sms-gateway-setup.md
BOLVERSE_SMS_PROVIDER=android
SMSGATE_USERNAME=...
SMSGATE_PASSWORD=...

# Payments
BOLVERSE_UPI_ID=yourname@okhdfcbank
BOLVERSE_PAYMENT_PROVIDER_INR=cashfree
BOLVERSE_PAYMENT_PROVIDER_USD=cashfree
CASHFREE_APP_ID=...
CASHFREE_SECRET_KEY=...
CASHFREE_ENV=production

# AI worker on Colab (section 14)
BOLVERSE_AI_URL=https://your-fixed-name.ngrok-free.dev
BOLVERSE_AI_SECRET=<printed by the Colab notebook>
```

```bash
sudo mkdir -p /var/lib/bolverse && sudo chown bolverse:bolverse /var/lib/bolverse && sudo chmod 700 /var/lib/bolverse
```

**Back up `BOLVERSE_DATA_KEY` somewhere other than the server and its backups**, for example in a password
manager. Without it, the encrypted phone numbers, names and messages can't be read.

## 9. Create the tables (migrations)

```bash
cd /opt/bolverse/bolverse/backend
sudo -u bolverse bash -c 'set -a; . /etc/bolverse/bolverse.env; set +a; /opt/bolverse/venv/bin/python -m app.manage migrate'
sudo -u bolverse bash -c 'set -a; . /etc/bolverse/bolverse.env; set +a; /opt/bolverse/venv/bin/python -m app.manage check'
```

`migrate` creates any missing tables, columns and indexes, and encrypts rows left by older versions. It is
safe to run again after every update. The tables:

| Table | Holds |
|---|---|
| `users` | Accounts. The phone number is stored as a blind index plus an encrypted copy; name and date of birth are encrypted. |
| `devices` | App installs (guests are counted per device) |
| `otp_codes` | Sign-in codes (hashed), attempt counters, the IP each request came from |
| `sessions` | Signed-in devices: rotating refresh-token hashes, revocation |
| `connections` | Connect conversations between two people |
| `connect_messages` | Messages waiting for delivery (encrypted; kept 24 h after delivery, up to 7 days if never delivered) |
| `connect_deliveries` | Which device has received which message |
| `connect_invites`, `push_tokens` | QR invites, push notification tokens |
| `payments`, `subscriptions` | Purchases and Premium periods |
| `admin_users`, `admin_sessions`, `audit_log` | Dashboard accounts, their sessions, and who changed what |

`check` must print no `PROBLEM:` lines before you go live.

## 10. Run the API as a service (systemd)

`/etc/systemd/system/bolverse.service`:

```ini
[Unit]
Description=Bolverse API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=bolverse
Group=bolverse
WorkingDirectory=/opt/bolverse/bolverse/backend
EnvironmentFile=/etc/bolverse/bolverse.env
ExecStart=/opt/bolverse/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 \
          --proxy-headers --forwarded-allow-ips 127.0.0.1 --workers 1
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/bolverse

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bolverse
systemctl status bolverse
curl -s -H 'X-Forwarded-Proto: https' http://127.0.0.1:8000/health
```

One worker is plenty: the API mostly waits on the AI worker and the database. The sign-in rate limits are
counted per worker process, so if you add workers they get proportionally looser (see `app/ratelimit.py`).

## 11. Web app files

The dashboard is already built into `backend/static/dashboard`, and the API serves it at `/dashboard`.
Build the web app on your PC, pointing it at the API:

```bash
# on your PC, in the project folder
echo VITE_API_URL=https://api.example.com > apps/web/.env
npm install && npm run web:build
scp -r apps/web/dist/* ubuntu@<public IP>:/tmp/web/
# on the server
sudo mkdir -p /var/www/bolverse-app && sudo cp -r /tmp/web/* /var/www/bolverse-app/
```

## 12. Nginx and HTTPS (Let's Encrypt)

`/etc/nginx/sites-available/bolverse`:

```nginx
server {
    listen 80;
    server_name api.example.com;
    client_max_body_size 16m;                 # voice recordings

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;              # translation with speech can take a while
    }
}

server {
    listen 80;
    server_name app.example.com;
    root /var/www/bolverse-app;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /assets/ { expires 30d; add_header Cache-Control "public, immutable"; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/bolverse /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com -d app.example.com --redirect -m you@example.com --agree-tos
sudo certbot renew --dry-run          # renewal works; a systemd timer renews automatically
```

`--redirect` sends all HTTP traffic to HTTPS. In production the API also refuses any request that didn't
arrive over HTTPS and sends HSTS (`X-Forwarded-Proto` comes from Nginx).

Check it with `https://api.example.com/health` and `https://app.example.com`, and sign in to
`https://api.example.com/dashboard`.

## 13. Health checks, logs and backups

**Health:**

- `GET https://api.example.com/health` returns `{"status":"ok", ...}` and shows whether the AI worker is
  reachable.
- Add it to a free uptime monitor (UptimeRobot, Better Stack, or similar) with email alerts.

**Logs:**

```bash
journalctl -u bolverse -f                 # API (auth events show masked numbers only)
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

Cap the journal's disk use: set `SystemMaxUse=500M` in `/etc/systemd/journald.conf`, then run
`sudo systemctl restart systemd-journald`. Nginx logs are rotated by logrotate already.

**Database backups:** run nightly, keep 14 days, and copy them off the server.

```bash
sudo mkdir -p /var/backups/bolverse && sudo chown postgres /var/backups/bolverse
sudo tee /etc/cron.d/bolverse-backup >/dev/null <<'CRON'
30 2 * * * postgres pg_dump -Fc bolverse > /var/backups/bolverse/bolverse-$(date +\%F).dump && find /var/backups/bolverse -name '*.dump' -mtime +14 -delete
CRON
```

- **Copy off the server:** send the dump files to OCI Object Storage (20 GB is free) with `rclone` or
  the OCI CLI, or simply download them weekly.
- **Disk snapshots:** a monthly boot volume backup (Block Storage → Boot Volumes → Create backup) is
  free up to 5 backups.
- **Restore test:** run `pg_restore -d bolverse_test /var/backups/bolverse/<file>.dump` into a scratch
  database now and then. A backup that has never been restored is a guess.

## 14. The AI models: keep them on Colab for now

The free VM has 2 Arm cores, 12 GB of memory and no GPU. The models Bolverse uses are:

- Whisper large-v3-turbo (speech recognition)
- NLLB 1.3B (translation)
- Qwen 2.5 3B (wording)
- MMS voices (speech)

Together they need about 9 GB of memory just to load. On 2 CPU cores, transcribing and translating one
short sentence would take tens of seconds. **They are too heavy for this VM.** Keep inference on Colab:

1. **Start Colab as the AI worker.** In the Colab notebook, set **Role = "AI worker for my Oracle
   server"** in cell 2. Also set a fixed `NGROK_DOMAIN` secret so the address doesn't change.
2. **Run all cells.** Cell 7 prints two lines:
   ```
   BOLVERSE_AI_URL=https://your-name.ngrok-free.dev
   BOLVERSE_AI_SECRET=...
   ```
3. **Connect the VM.** Put both lines in `/etc/bolverse/bolverse.env` and run
   `sudo systemctl restart bolverse`.

**Limits:**

- Free Colab sessions stop after some hours or when idle. While Colab is off, accounts, Connect chats,
  payments and the dashboard keep working, but translation answers "AI is unavailable" until you start
  the notebook again.
- Colab is not a production service. For always-on AI, move the worker to a GPU host such as RunPod
  serverless (`backend/Dockerfile.ai`) and change `BOLVERSE_AI_URL`.

## 15. Updating to a new version

```bash
scp bolverse.zip ubuntu@<ip>:/tmp/ && ssh ubuntu@<ip>
sudo systemctl stop bolverse
sudo -u postgres pg_dump -Fc bolverse > /var/backups/bolverse/pre-update-$(date +%F).dump
sudo rm -rf /opt/bolverse/bolverse && sudo unzip -q /tmp/bolverse.zip -d /opt/bolverse/ && sudo chown -R bolverse:bolverse /opt/bolverse
sudo -u bolverse /opt/bolverse/venv/bin/pip install -r /opt/bolverse/bolverse/backend/requirements-api.txt
cd /opt/bolverse/bolverse/backend && sudo -u bolverse bash -c 'set -a; . /etc/bolverse/bolverse.env; set +a; /opt/bolverse/venv/bin/python -m app.manage migrate'
sudo systemctl start bolverse
```

Then point the mobile app at `https://api.example.com` (`EXPO_PUBLIC_API_URL` in `apps/mobile/.env`) and
build a new release.

## 16. Cost safeguards checklist

- [ ] Budget alert at ₹100 / US$1 with email (section 1).
- [ ] Everything is in the **home region** and marked "Always Free-eligible".
- [ ] A1 instances in total ≤ **2 OCPUs and 12 GB**. Check under Compute → Instances.
- [ ] Boot + block volumes ≤ **200 GB**, and volume backups ≤ **5**.
- [ ] No paid extras: no extra load balancers, no paid database, no GPU shapes, no reserved capacity.
- [ ] Before the 30-day trial ends: delete anything you created with trial credits that isn't Always
      Free (the console marks these).
- [ ] Look at **Billing → Cost Analysis** once a week for the first month. It should show ₹0.
- [ ] If you upgrade to Pay As You Go later (for example to escape idle reclamation), keep the budget
      alert; anything beyond Always Free is then billed.

## Appendix: Oracle Autonomous Database instead of PostgreSQL

Not used in this setup (decision of 21 Oct 2026), and **Bolverse is not tested against Oracle Database**.
If you switch later:

1. **Create the database.** Go to **Oracle Database → Autonomous Database → Create**, choose
   "Always Free", workload "Transaction Processing", and set an ADMIN password.
2. **Get the wallet.** Under **Database connection → Download wallet**, set a wallet password and unzip
   it to `/etc/bolverse/wallet` (mode 750, group `bolverse`).
3. **Install the driver:** `pip install oracledb`. Its default thin mode needs no Oracle Client.
4. **Set the database URL:**
   `BOLVERSE_DATABASE_URL=oracle+oracledb://ADMIN:<password>@<service>_low?config_dir=/etc/bolverse/wallet&wallet_location=/etc/bolverse/wallet&wallet_password=<wallet password>`
   The service name is in `tnsnames.ora` in the wallet.
5. **Test before moving data.** Run `python -m app.manage migrate`, then the test suites with
   `TEST_DATABASE_URL` set to that URL. Oracle has no plain `BOOLEAN` column type in older versions and
   treats empty strings as NULL, so expect some fixes.

Each Always Free Autonomous Database is limited to 1 OCPU, 20 GB and 20 simultaneous sessions, and is
stopped after 7 days without use.

## Sources (checked 21 October 2026)

- Always Free resources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm
- Free Tier overview (A1 limit, trial, home region): https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- Report on the 2026 A1 reduction: https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/
