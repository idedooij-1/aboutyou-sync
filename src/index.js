require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');
const { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate, checkAndListNewProducts, listAllProducts, checkNewBrands } = require('./sync');
const { getCollectionVariants, getProductsByIds } = require('./shopify');
const { getCategories, getCategoryAttributeGroups, getBrands, getRejectedProducts, getAllProducts, deleteProduct, updateProductStatus } = require('./aboutyou');
const { mountAuthRoutes } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve padded 3:4 images for AboutYou from the persistent data volume.
// Shopify is never modified — these files exist only on this server.
app.use('/images', express.static(path.join(__dirname, '..', 'data', 'images')));

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
    <button class="btn-green" onclick="trigger('/sync/list-all', this)" style="background:#15803d">📤 List ALL products</button>
    <button class="btn-accent" onclick="trigger('/list', this, 'GET')">📋 List collection</button>
    <button class="btn-primary" onclick="trigger('/sync/stock', this)">📦 Sync stock</button>
    <button class="btn-secondary" onclick="trigger('/sync/prices', this)">💶 Sync prices</button>
    <button class="btn-secondary" onclick="lookupCategories()">🔍 Find category IDs</button>
    <button class="btn-secondary" onclick="trigger('/config/brands', this, 'GET')">🏷 List brand IDs</button>
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

    async function lookupCategories() {
      const q = prompt('Search category name (e.g. "Sunglasses"):');
      if (q === null) return;
      const res = await fetch('/config/categories?q=' + encodeURIComponent(q), {
        headers: { 'x-sync-token': SYNC_TOKEN }
      });
      const data = await res.json();
      const out = document.getElementById('output');
      document.getElementById('output-label').textContent = 'GET /config/categories?q=' + q;
      document.getElementById('output-body').textContent = JSON.stringify(data, null, 2);
      out.classList.add('visible');
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

// Full listing: push every product in the collection to AboutYou (ignores known-SKU state)
app.post('/sync/list-all', authGuard, async (req, res) => {
  try {
    const result = await listAllProducts();
    res.json(result);
  } catch (err) {
    console.error('[sync/list-all] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cleanup: delete AY products whose SKU is not in the Shopify "aboutyou" collection.
// Dry-run by default; pass ?confirm=true to actually delete.
app.post('/sync/cleanup', authGuard, async (req, res) => {
  try {
    const dryRun = req.query.confirm !== 'true';
    const handle = process.env.ABOUTYOU_COLLECTION_HANDLE || 'aboutyou';

    // Shopify collection SKUs
    const variants = await getCollectionVariants(handle);
    const shopifySkus = new Set(variants.map(v => v.sku).filter(Boolean));

    // All AY listed products
    console.log('[cleanup] Fetching all AboutYou products...');
    const ayProducts = await getAllProducts();
    console.log(`[cleanup] ${ayProducts.length} products on AY, ${shopifySkus.size} SKUs in Shopify collection`);

    const toDelete = ayProducts.filter(p => !shopifySkus.has(p.sku));
    console.log(`[cleanup] ${toDelete.length} products to delete`);

    const deleted = [];
    const errors = [];

    if (!dryRun) {
      for (const p of toDelete) {
        try {
          await deleteProduct(p.sku);
          deleted.push(p.sku);
          console.log(`[cleanup] Deleted SKU ${p.sku} (${p.name || p.style_key})`);
        } catch (err) {
          const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          errors.push({ sku: p.sku, error: msg });
          console.error(`[cleanup] Failed to delete SKU ${p.sku}: ${msg}`);
        }
        // Respect AboutYou rate limit
        await new Promise(r => setTimeout(r, 400));
      }
    }

    res.json({
      dryRun,
      shopifySkuCount: shopifySkus.size,
      ayProductCount: ayProducts.length,
      toDeleteCount: toDelete.length,
      toDelete: toDelete.map(p => ({ sku: p.sku, style_key: p.style_key, name: p.name, status: p.status })),
      deleted: dryRun ? [] : deleted,
      errors: dryRun ? [] : errors,
    });
  } catch (err) {
    console.error('[cleanup] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete all rejected products from AY, then re-list only those from Shopify.
// Strategy: get rejected style_keys → cross-ref with getAllProducts() to find SKUs → delete → re-list.
app.post('/sync/fix-rejected', authGuard, async (req, res) => {
  try {
    const { mapProducts } = require('./listing');
    const { getAyImageUrls } = require('./images');
    const { graphql } = require('./shopify');
    const fs = require('fs');
    const path = require('path');
    const STATE_FILE = path.join(__dirname, '..', 'data', 'known-skus.json');

    // 1. Get rejected style_keys
    const rejected = await getRejectedProducts();
    const rejectedItems = rejected.items || [];
    if (rejectedItems.length === 0) return res.json({ message: 'No rejected products found', deleted: [], relisted: [] });
    const rejectedStyleKeys = new Set(rejectedItems.map(i => i.style_key).filter(Boolean));
    console.log(`[fix-rejected] ${rejectedStyleKeys.size} rejected style_key(s):`, [...rejectedStyleKeys].join(', '));

    // 2. Get all AY products, find SKUs matching the rejected style_keys
    const allAyProducts = await getAllProducts();
    const skusToDelete = allAyProducts
      .filter(p => rejectedStyleKeys.has(p.style_key))
      .map(p => p.sku)
      .filter(Boolean);
    console.log(`[fix-rejected] SKUs to delete: ${skusToDelete.join(', ')}`);

    // 3. Delete each SKU from AY
    const deleted = [];
    const deleteErrors = [];
    for (const sku of skusToDelete) {
      try {
        await deleteProduct(sku);
        deleted.push(sku);
        console.log(`[fix-rejected] Deleted SKU ${sku}`);
      } catch (err) {
        deleteErrors.push({ sku, error: err.response?.data || err.message });
        console.error(`[fix-rejected] Failed to delete SKU ${sku}:`, err.response?.data || err.message);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    // Remove from known-skus.json
    const skusToRemove = new Set(skusToDelete);
    try {
      const knownSkus = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const updated = knownSkus.filter(s => !skusToRemove.has(s));
      fs.writeFileSync(STATE_FILE, JSON.stringify(updated));
      console.log(`[fix-rejected] Removed ${knownSkus.length - updated.length} SKU(s) from known-skus.json`);
    } catch { /* file may not exist */ }

    // 4. Extract Shopify product GIDs from rejected style_keys
    const productGids = [...rejectedStyleKeys]
      .map(sk => { const m = sk.match(/^shopify-(\d+)$/); return m ? `gid://shopify/Product/${m[1]}` : null; })
      .filter(Boolean);
    console.log(`[fix-rejected] Fetching ${productGids.length} Shopify product(s)`);

    // 5. Fetch products from Shopify
    const shopifyProducts = await getProductsByIds(productGids);
    if (shopifyProducts.length === 0) {
      return res.json({ message: 'Deleted from AY but could not find Shopify products', deleted, deleteErrors, relisted: [] });
    }

    // 6. Process images and map
    for (const product of shopifyProducts) {
      product._ayImageUrls = await getAyImageUrls(product, graphql);
    }
    const ayItems = mapProducts(shopifyProducts);
    if (ayItems.length === 0) {
      return res.json({ message: 'No mappable variants found', deleted, deleteErrors, relisted: [] });
    }

    // 7. Re-list on AY
    const batchResults = await (require('./aboutyou').listProducts)(ayItems);
    const relisted = ayItems.map(i => i.sku);

    // Update known-skus.json
    try {
      const knownSkus = new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      relisted.forEach(s => knownSkus.add(s));
      fs.writeFileSync(STATE_FILE, JSON.stringify([...knownSkus]));
    } catch { fs.writeFileSync(STATE_FILE, JSON.stringify(relisted)); }

    console.log(`[fix-rejected] Done. Deleted ${deleted.length}, re-listed ${relisted.length}`);
    res.json({ deleted, deleteErrors, relisted, batchResults });
  } catch (err) {
    console.error('[fix-rejected] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Relist specific products by numeric Shopify product IDs.
// Useful when fix-rejected already deleted products but re-listing silently failed.
// Polls the AY batch result for up to 60s so you can see validation errors.
// Body: { productIds: [8724604256594, ...] }
app.post('/sync/relist-products', authGuard, async (req, res) => {
  try {
    const { mapProducts } = require('./listing');
    const { getAyImageUrls } = require('./images');
    const { getProductsByIds, graphql } = require('./shopify');
    const { listProducts, getProductBatchResults } = require('./aboutyou');

    const productIds = req.body.productIds || [];
    if (productIds.length === 0) return res.status(400).json({ error: 'productIds array required' });

    const productGids = productIds.map(id => `gid://shopify/Product/${id}`);
    console.log(`[relist-products] Fetching ${productGids.length} Shopify product(s)`);

    const shopifyProducts = await getProductsByIds(productGids);
    if (shopifyProducts.length === 0) {
      return res.json({ error: 'No products found in Shopify', productGids });
    }
    console.log(`[relist-products] Got ${shopifyProducts.length} product(s) from Shopify`);

    for (const product of shopifyProducts) {
      product._ayImageUrls = await getAyImageUrls(product, graphql);
      console.log(`[relist-products] "${product.title}": ${product._ayImageUrls.length} image(s)`);
    }

    const ayItems = mapProducts(shopifyProducts);
    if (ayItems.length === 0) {
      const debug = shopifyProducts.map(p => ({
        title: p.title, vendor: p.vendor, productType: p.productType,
        images: p._ayImageUrls?.length || 0,
        variants: p.variants?.nodes?.length || 0,
      }));
      return res.json({ message: 'mapProducts produced 0 items — check brand/category/images', debug });
    }
    console.log(`[relist-products] Mapped ${ayItems.length} AY item(s), submitting...`);

    const batchResults = await listProducts(ayItems);
    console.log(`[relist-products] Submitted. Polling batch results...`);

    // Poll each batch for up to 20s (4 × 5s)
    const batchDetails = [];
    for (const br of batchResults) {
      if (!br || !br.batchRequestId) {
        batchDetails.push({ error: 'No batchRequestId in response', raw: br });
        continue;
      }
      let pollResult = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          pollResult = await getProductBatchResults(br.batchRequestId);
          console.log(`[relist-products] Batch ${br.batchRequestId} status: ${pollResult.status}`);
          if (pollResult.status === 'completed' || pollResult.status === 'failed') break;
        } catch (e) {
          pollResult = { error: e.message };
          break;
        }
      }
      batchDetails.push({ batchRequestId: br.batchRequestId, pollResult });
    }

    res.json({
      skus: ayItems.map(i => i.sku),
      firstItemSample: ayItems[0],
      batchResults,
      batchDetails,
    });
  } catch (err) {
    console.error('[relist-products] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message, detail: err.response?.data });
  }
});

// Submit all draft products for approval (status → published)
app.post('/sync/submit-for-approval', authGuard, async (req, res) => {
  try {
    const ayProducts = await getAllProducts();
    const drafts = ayProducts.filter(p => p.status === 'draft');
    // Deduplicate by style_key
    const styleKeys = [...new Set(drafts.map(p => p.style_key).filter(Boolean))];
    if (styleKeys.length === 0) return res.json({ message: 'No draft products found', submitted: 0 });
    const items = styleKeys.map(style_key => ({ style_key, status: 'published' }));
    const result = await updateProductStatus(items);
    res.json({ submitted: styleKeys.length, styleKeys, result });
  } catch (err) {
    console.error('[submit-for-approval] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Config lookup helpers — returns AY category/brand/attribute IDs for use in .env
app.get('/config/categories', authGuard, async (req, res) => {
  try {
    const items = await getCategories(req.query.q || '');
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config/category/:id/attributes', authGuard, async (req, res) => {
  try {
    const attrs = await getCategoryAttributeGroups(parseInt(req.params.id, 10));
    res.json(attrs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config/batch/:id', authGuard, async (req, res) => {
  try {
    const { getProductBatchResults } = require('./aboutyou');
    const result = await getProductBatchResults(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config/rejected', authGuard, async (req, res) => {
  try {
    const result = await getRejectedProducts(req.query.style_key);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config/brands', authGuard, async (req, res) => {
  try {
    const items = await getBrands();
    res.json(items);
  } catch (err) {
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

// New product check + brand check every hour
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Running hourly new products check');
  try {
    await checkAndListNewProducts();
  } catch (err) {
    console.error('[cron] new products check error:', err.message);
  }

  console.log('[cron] Running hourly brand check');
  try {
    await checkNewBrands();
  } catch (err) {
    console.error('[cron] brand check error:', err.message);
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
  console.log(`[server] Scheduled: stock every 15 min, prices + new products + brand check every hour`);
});
