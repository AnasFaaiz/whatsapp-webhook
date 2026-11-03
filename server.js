require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const PORT = process.env.PORT || 3000;

if (!VERIFY_TOKEN || !APP_SECRET) {
    console.error('Missing VERIFY_TOKEN or APP_SECRET env vars (see .env.example)');
    process.exit(1);
}

const app = express();

// Keep the raw bytes: the signature is computed over them, not over re-serialized JSON.
app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));

function validSignature(req) {
    const header = req.get('x-hub-signature-256');
    if (!header || !req.rawBody) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Dedupe: Meta may redeliver the same event. In-memory with TTL; use Redis/DB in production.
const seen = new Map();
const SEEN_TTL_MS = 60 * 60 * 1000;
function alreadySeen(id) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
    if (seen.has(id)) return true;
    seen.set(id, now);
    return false;
}

function handleMessage(msg, value) {
    if (alreadySeen(msg.id)) {
        console.log(`↩️  duplicate message ${msg.id}, skipped`);
        return;
    }
    const name = value.contacts?.[0]?.profile?.name;
    console.log(`📩 [${msg.type}] from ${msg.from}${name ? ` (${name})` : ''} id=${msg.id}`);
    switch (msg.type) {
        case 'text':
            console.log('   text:', msg.text?.body);
            break;
        case 'image': case 'audio': case 'video': case 'document': case 'sticker':
            console.log('   media id:', msg[msg.type]?.id);
            break;
        case 'interactive':
            console.log('   interactive reply:', JSON.stringify(msg.interactive));
            break;
        case 'button':
            console.log('   button:', msg.button?.text);
            break;
        default:
            console.log('   unhandled type, raw:', JSON.stringify(msg));
    }
}

function handleStatus(status) {
    // sent | delivered | read | failed
    const key = `status:${status.id}:${status.status}`;
    if (alreadySeen(key)) return;
    console.log(`📊 status ${status.status} for ${status.id} → ${status.recipient_id}`);
    if (status.status === 'failed') {
        console.error('   errors:', JSON.stringify(status.errors));
    }
}

function processPayload(body) {
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
            if (change.field !== 'messages') continue;
            const value = change.value ?? {};
            for (const msg of value.messages ?? []) handleMessage(msg, value);
            for (const st of value.statuses ?? []) handleStatus(st);
        }
    }
}

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verified by Meta');
        return res.status(200).type('text/plain').send(String(challenge));
    }
    return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    if (!validSignature(req)) {
        console.warn('⛔ Rejected POST: invalid or missing signature');
        return res.sendStatus(403);
    }
    // Acknowledge first, process after, so Meta never waits on our logic.
    res.sendStatus(200);
    try {
        processPayload(req.body);
    } catch (err) {
        console.error('Error processing payload:', err);
    }
});

app.listen(PORT, () => console.log(`🚀 Webhook server listening on port ${PORT}`));
