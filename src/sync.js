const fs = require('fs');
const path = require('path');
const { getCollectionVariants } = require('./shopify');

const COLLECTION_HANDLE = process.env.ABOUTYOU_COLLECTION_HANDLE || 'aboutyou';
const STATE_FILE = path.join(__dirname, '..', 'data', 'known-skus.json');

function loadKnownSkus() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    return new Set(); // First run or file missing — treat all as new
  }
}

function saveKnownSkus(skus) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...skus]));
}
const { updateStock, updatePrices } = require('./aboutyou');

// Country codes to sync prices for (e.g. "DE,AT,NL,BE")
const COUNTRY_CODES = (process.env.ABOUTYOU_COUNTRY_CODES || 'DE').split(',').map(c => c.trim());

async function syncStock() {
  console.log('[sync] Starting stock sync...');
  const variants = await getCollectionVariants(COLLECTION_HANDLE);

  const items = variants.map(v => ({
    sku: v.sku,
    quantity: Math.max(0, v.inventoryQuantity || 0),
    valid_at: v.updatedAt,
  }));

  if (items.length === 0) {
    console.log('[sync] No variants with SKUs found.');
    return;
  }

  console.log(`[sync] Syncing stock for ${items.length} variants...`);
  await updateStock(items);
  console.log('[sync] Stock sync complete.');
}

async function syncPrices() {
  console.log('[sync] Starting price sync...');
  const variants = await getCollectionVariants(COLLECTION_HANDLE);

  // For each variant + country, emit one price item
  const items = [];
  for (const v of variants) {
    for (const country_code of COUNTRY_CODES) {
      items.push({
        sku: v.sku,
        price: {
          country_code,
          retail_price: parseFloat(v.compareAtPrice || v.price),
          sale_price: v.compareAtPrice ? parseFloat(v.price) : null,
        },
      });
    }
  }

  if (items.length === 0) {
    console.log('[sync] No variants with SKUs found.');
    return;
  }

  console.log(`[sync] Syncing prices for ${variants.length} variants × ${COUNTRY_CODES.length} countries...`);
  await updatePrices(items);
  console.log('[sync] Price sync complete.');
}

// Handle a single inventory webhook payload
async function handleInventoryUpdate(payload) {
  const sku = payload.sku;
  if (!sku) return;

  const quantity = Math.max(0, payload.available || 0);
  console.log(`[sync] Webhook inventory update: sku=${sku} quantity=${quantity}`);
  await updateStock([{ sku, quantity }]);
}

// Handle a single product update webhook (price changes)
async function handleProductUpdate(payload) {
  const variants = (payload.variants || []).filter(v => v.sku);
  if (variants.length === 0) return;

  const items = [];
  for (const v of variants) {
    for (const country_code of COUNTRY_CODES) {
      items.push({
        sku: v.sku,
        price: {
          country_code,
          retail_price: parseFloat(v.compare_at_price || v.price),
          sale_price: v.compare_at_price ? parseFloat(v.price) : null,
        },
      });
    }
  }

  console.log(`[sync] Webhook product update: ${variants.length} variants`);
  await updatePrices(items);
}

// Check the AboutYou Shopify collection for new products and list them on AboutYou
async function checkAndListNewProducts() {
  console.log('[sync] Checking for new products in collection...');
  const variants = await getCollectionVariants(COLLECTION_HANDLE);
  const knownSkus = loadKnownSkus();

  const newVariants = variants.filter(v => !knownSkus.has(v.sku));

  // Always persist the current full set (handles removals too)
  saveKnownSkus(new Set(variants.map(v => v.sku)));

  if (newVariants.length === 0) {
    console.log('[sync] No new products found.');
    return { newProducts: [] };
  }

  const newProductTitles = [...new Set(newVariants.map(v => v.product.title))];
  console.log(`[sync] ${newVariants.length} new variant(s) across ${newProductTitles.length} product(s): ${newProductTitles.join(', ')}`);

  // Push stock
  const stockItems = newVariants.map(v => ({
    sku: v.sku,
    quantity: Math.max(0, v.inventoryQuantity || 0),
    valid_at: v.updatedAt,
  }));
  await updateStock(stockItems);

  // Push prices
  const priceItems = [];
  for (const v of newVariants) {
    for (const country_code of COUNTRY_CODES) {
      priceItems.push({
        sku: v.sku,
        price: {
          country_code,
          retail_price: parseFloat(v.compareAtPrice || v.price),
          sale_price: v.compareAtPrice ? parseFloat(v.price) : null,
        },
      });
    }
  }
  await updatePrices(priceItems);

  console.log('[sync] New products listed on AboutYou.');
  return { newProducts: newProductTitles };
}

module.exports = { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate, checkAndListNewProducts };
