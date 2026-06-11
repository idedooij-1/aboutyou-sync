require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate } = require('./sync');
const { mountAuthRoutes } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Shopify webhook verification ---
function verifyShopifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !process.env.SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// Raw body needed for HMAC verification
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

// --- OAuth setup (one-time, to get SHOPIFY_ACCESS_TOKEN) ---
mountAuthRoutes(app);

// --- Health check ---
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// --- Shopify webhooks ---
app.post('/webhooks/inventory-update', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.sendStatus(200); // Acknowledge immediately

  try {
    const payload = JSON.parse(req.body.toString());
    await handleInventoryUpdate(payload);
  } catch (err) {
    console.error('[webhook] inventory-update error:', err.message);
  }
});

app.post('/webhooks/product-update', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);

  try {
    const payload = JSON.parse(req.body.toString());
    await handleProductUpdate(payload);
  } catch (err) {
    console.error('[webhook] product-update error:', err.message);
  }
});

// --- Manual sync endpoints (protected by a simple token) ---
function authGuard(req, res, next) {
  const token = req.headers['x-sync-token'];
  if (process.env.SYNC_TOKEN && token !== process.env.SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/sync/stock', authGuard, async (req, res) => {
  res.json({ message: 'Stock sync started' });
  try {
    await syncStock();
  } catch (err) {
    console.error('[sync/stock] error:', err.message);
  }
});

app.post('/sync/prices', authGuard, async (req, res) => {
  res.json({ message: 'Price sync started' });
  try {
    await syncPrices();
  } catch (err) {
    console.error('[sync/prices] error:', err.message);
  }
});

// --- Scheduled jobs ---
// Stock sync every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('[cron] Running scheduled stock sync');
  try {
    await syncStock();
  } catch (err) {
    console.error('[cron] stock sync error:', err.message);
  }
});

// Price sync every hour
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Running scheduled price sync');
  try {
    await syncPrices();
  } catch (err) {
    console.error('[cron] price sync error:', err.message);
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Webhooks: POST /webhooks/inventory-update  POST /webhooks/product-update`);
  console.log(`[server] Manual sync: POST /sync/stock  POST /sync/prices`);
  console.log(`[server] Scheduled: stock every 15 min, prices every hour`);
});
