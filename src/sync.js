const { getAllVariants } = require('./shopify');
const { updateStock, updatePrices } = require('./aboutyou');

// Country codes to sync prices for (e.g. "DE,AT,NL,BE")
const COUNTRY_CODES = (process.env.ABOUTYOU_COUNTRY_CODES || 'DE').split(',').map(c => c.trim());

async function syncStock() {
  console.log('[sync] Starting stock sync...');
  const variants = await getAllVariants();

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
  const variants = await getAllVariants();

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

module.exports = { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate };
