# WhatsApp Webhook Server

A Node.js/Express webhook endpoint for the WhatsApp Business (Meta Cloud API), implementing:

- GET verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- POST payload signature validation (`X-Hub-Signature-256`, HMAC-SHA256, constant-time compare)
- Message/status event parsing with in-memory deduplication (handles Meta's retries/redelivery)

## Prerequisites

- Node.js 18+ (optional chaining syntax requires this)
- npm
- A Meta App with WhatsApp product added (for `APP_SECRET` and to register the callback URL)

## Local setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
VERIFY_TOKEN=choose_any_string_yourself
APP_SECRET=your_real_meta_app_secret   # App Dashboard → Settings → Basic
PORT=3000
```

Run:

```bash
node server.js
```

## Testing locally

**GET verification handshake:**

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=12345"
```

Expect `12345` returned, and `✅ Webhook verified by Meta` logged.

**POST signature validation:**

```bash
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"messages":[{"id":"wamid.test123","from":"911234567890","type":"text","text":{"body":"hello"}}]}}]}]}'

SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')

curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: sha256=$SIG" \
  -d "$BODY"
```

Expect `200`, and a `📩 [text] from 911234567890 ... text: hello` log line.

## Deploying for Meta webhook registration

Meta requires the callback URL to be **publicly reachable over HTTPS with a valid (non-self-signed) TLS certificate**. A plain HTTP URL or a bare IP address will not be accepted.

Deployed and tested on an AWS EC2 instance (Ubuntu), behind **nginx** as a reverse proxy, with a free **Let's Encrypt** certificate via **certbot**, using a free **Duck DNS** subdomain pointed at the instance's public IP (since Let's Encrypt cannot issue certs for bare IP addresses).

High-level flow:

```
Internet (Meta) → nginx :443 (TLS) → proxy_pass → localhost:3000 (this app)
```

Deployment/infra steps (EC2 provisioning, nginx config, certbot) are not included in this repo, as they are specific to the hosting environment rather than the application itself.

### Registering the webhook

1. In Meta App Dashboard → WhatsApp → Configuration, enter:
   - **Callback URL**: `https://<your-domain>/webhook`
   - **Verify token**: same value as `VERIFY_TOKEN` in `.env`
2. Click **Verify and save**. Meta sends a GET request matching the handshake above.
3. On success, Meta displays the list of webhook fields to subscribe to (e.g. `messages`, `message_template_status_update`).

## Restarting after an EC2 stop/start

EC2 instances (without an Elastic IP attached) get a **new public IP** every time they're stopped and started — the old IP is released on stop, not reserved. This breaks SSH access and the DNS record until updated. Steps after a restart:

1. **Start the instance** (from local machine, AWS CLI configured):
   ```bash
   aws ec2 start-instances --instance-ids <instance-id> --region <region>
   ```

2. **Get the new public IP** (wait ~30s after starting):
   ```bash
   aws ec2 describe-instances \
     --instance-ids <instance-id> \
     --query 'Reservations[0].Instances[0].PublicIpAddress' \
     --region <region> \
     --output text
   ```

3. **Update the DNS record** (e.g. Duck DNS) to point the domain at the new IP — otherwise `https://<domain>/webhook` resolves to the old, now-wrong address.

4. **Check your own current public IP** (it may also have changed, e.g. after a WiFi switch):
   ```bash
   curl -s https://checkip.amazonaws.com
   ```

5. **Re-authorize SSH (port 22) for your current IP**, since the security group only trusts a specific `/32` address at a time:
   ```bash
   aws ec2 authorize-security-group-ingress \
     --group-id <security-group-id> \
     --protocol tcp --port 22 \
     --cidr <your-current-ip>/32 \
     --region <region>
   ```
   (Safe to re-run even if unchanged — it just reports the rule already exists.)

6. **SSH in using the new instance IP**:
   ```bash
   ssh -i <your-key>.pem ubuntu@<new-public-ip>
   ```

7. **Restart the app** (nginx and the Let's Encrypt cert persist across stop/start automatically, since they live on the instance's disk — no need to reinstall or re-run certbot unless the domain itself changed):
   ```bash
   node server.js
   ```

8. **Re-test the handshake** to confirm everything's live again:
   ```bash
   curl "https://<your-domain>/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=12345"
   ```

> To avoid steps 2–3 entirely in the future, allocate an **Elastic IP** and associate it with the instance — the public IP then stays fixed across stop/start cycles.

## Notes

- `req.rawBody` is preserved via the `express.json({ verify })` hook because the HMAC signature must be computed over the exact raw bytes Meta sent, not a re-serialized JSON object.
- Signature comparison uses `crypto.timingSafeEqual` to avoid timing-attack leakage.
- Deduplication is in-memory with a 1-hour TTL; swap for Redis/a database in a multi-instance or production deployment.
- The POST handler responds `200` immediately before processing the payload, so Meta's delivery isn't blocked by app logic.
