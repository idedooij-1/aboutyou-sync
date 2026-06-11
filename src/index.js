require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate, checkAndListNewProducts } = require('./sync');
const { getCollectionVariants } = require('./shopify');
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

// --- Dashboard UI ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AboutYou Sync</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; padding: 32px 16px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.875rem; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 20px; max-width: 540px; margin: 0 auto 20px; }
    label { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #555; display: block; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 9px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem; outline: none; }
    input[type=password]:focus { border-color: #555; }
    .actions { max-width: 540px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    button { padding: 11px 16px; border: none; border-radius: 7px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: opacity .15s; }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: #1a1a1a; color: #fff; }
    .btn-secondary { background: #e8e8e8; color: #222; }
    .btn-accent { background: #2563eb; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }
    .output-card { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 20px; max-width: 540px; margin: 16px auto 0; display: none; }
    .output-card.visible { display: block; }
    .output-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin-bottom: 8px; }
    pre { font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; color: #333; max-height: 360px; overflow-y: auto; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; margin-right: 6px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div style="max-width:540px;margin:0 auto 20px">
    <h1>AboutYou Sync</h1>
    <p class="subtitle">Manual controls for the Shopify → AboutYou sync service</p>
  </div>

  <div class="actions">
    <button class="btn-green" onclick="trigger('/sync/new-products', this)">🆕 List new products</button>
    <button class="btn-accent" onclick="trigger('/list', this, 'GET')">📋 List collection</button>
    <button class="btn-primary" onclick="trigger('/sync/stock', this)">📦 Sync stock</button>
    <button class="btn-secondary" onclick="trigger('/sync/prices', this)">💶 Sync prices</button>
  </div>

  <div class="output-card" id="output">
    <div class="output-label" id="output-label">Response</div>
    <pre id="output-body"></pre>
  </div>

  <script>
    const SYNC_TOKEN = 'a4df6864706eaa1e7c249483d0173d6f7fef12b6a586d264984bb74abb9eef9d';

    async function trigger(path, btn, method = 'POST') {
      const token = SYNC_TOKEN;
      const label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Running…';

      try {
        const res = await fetch(path, {
          method,
          headers: { 'x-sync-token': token, 'Content-Type': 'application/json' },
        });
        const text = await res.text();
        let pretty;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { pretty = text; }

        const out = document.getElementById('output');
        document.getElementById('output-label').textContent = method + ' ' + path + '  →  ' + res.status;
        document.getElementById('output-body').textContent = pretty;
        out.classList.add('visible');
      } catch (err) {
        document.getElementById('output-body').textContent = 'Error: ' + err.message;
        document.getElementById('output').classList.add('visible');
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    }
  </script>
</body>
</html>`);
});

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

// List all products/variants in the AboutYou Shopify collection
app.get('/list', authGuard, async (req, res) => {
  try {
    const handle = process.env.ABOUTYOU_COLLECTION_HANDLE || 'aboutyou';
    const variants = await getCollectionVariants(handle);

    // Group by product for a readable response
    const products = {};
    for (const v of variants) {
      const key = v.product.id;
      if (!products[key]) products[key] = { title: v.product.title, variants: [] };
      products[key].variants.push({
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        stock: v.inventoryQuantity,
      });
    }

    res.json({
      collection: handle,
      productCount: Object.keys(products).length,
      variantCount: variants.length,
      products: Object.values(products),
    });
  } catch (err) {
    console.error('[list] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/new-products', authGuard, async (req, res) => {
  try {
    const result = await checkAndListNewProducts();
    res.json(result);
  } catch (err) {
    console.error('[sync/new-products] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// New product check at 06:00 and 18:00
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running new products check (06:00)');
  try {
    await checkAndListNewProducts();
  } catch (err) {
    console.error('[cron] new products check error:', err.message);
  }
});

cron.schedule('0 18 * * *', async () => {
  console.log('[cron] Running new products check (18:00)');
  try {
    await checkAndListNewProducts();
  } catch (err) {
    console.error('[cron] new products check error:', err.message);
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
  console.log(`[server] Scheduled: stock every 15 min, prices every hour, new products at 06:00 & 18:00`);
});
