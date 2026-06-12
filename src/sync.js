const fs = require('fs');
const path = require('path');
const { getCollectionVariants, getProductsForListing } = require('./shopify');
const { mapProducts } = require('./listing');

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
const { updateStock, updatePrices, listProducts } = require('./aboutyou');

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

// Fetch the full collection from Shopify and list all new products on AboutYou.
// "New" means: the product's SKUs have not been seen before (tracked in known-skus.json).
// For new products: pushes the full listing (name, images, attributes, prices, stock).
// Existing products are skipped to avoid overwriting manual changes on AboutYou.
async function checkAndListNewProducts() {
  console.log('[sync] Checking for new products in collection...');

  // Get lightweight variant list to detect new SKUs quickly
  const variants = await getCollectionVariants(COLLECTION_HANDLE);
  const knownSkus = loadKnownSkus();

  const newSkus = new Set(variants.filter(v => !knownSkus.has(v.sku)).map(v => v.sku));

  // Persist updated SKU set (handles removals too)
  saveKnownSkus(new Set(variants.map(v => v.sku)));

  if (newSkus.size === 0) {
    console.log('[sync] No new products found.');
    return { newProducts: [] };
  }

  // Fetch full product data (images, options, description) for the collection
  const allProducts = await getProductsForListing(COLLECTION_HANDLE);

  // Keep only products that have at least one new SKU
  const newShopifyProducts = allProducts.filter(p =>
    p.variants.nodes.some(v => newSkus.has(v.sku))
  );

  const newProductTitles = newShopifyProducts.map(p => p.title);
  console.log(`[sync] ${newSkus.size} new SKU(s) across ${newProductTitles.length} product(s): ${newProductTitles.join(', ')}`);

  // Map to AboutYou payload and push listing
  const ayProducts = mapProducts(newShopifyProducts);
  if (ayProducts.length > 0) {
    await listProducts(ayProducts);
    console.log('[sync] Product listing pushed to AboutYou.');
  }

  return { newProducts: newProductTitles };
}

// List ALL products in the collection on AboutYou, regardless of known-SKU state.
// Use this for a full re-sync or initial import.
async function listAllProducts() {
  console.log('[sync] Fetching all products for full listing...');
  const shopifyProducts = await getProductsForListing(COLLECTION_HANDLE);

  if (shopifyProducts.length === 0) {
    console.log('[sync] No products found in collection.');
    return { listedProducts: [] };
  }

  const ayProducts = mapProducts(shopifyProducts);
  console.log(`[sync] Listing ${ayProducts.length} product(s) on AboutYou...`);
  await listProducts(ayProducts);

  // Update known SKUs so the incremental check stays in sync
  const allVariants = await getCollectionVariants(COLLECTION_HANDLE);
  saveKnownSkus(new Set(allVariants.map(v => v.sku)));

  const titles = ayProducts.map(p => p.name);
  console.log('[sync] Full listing complete.');
  return { listedProducts: titles };
}

module.exports = { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate, checkAndListNewProducts, listAllProducts };
