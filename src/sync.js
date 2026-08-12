const fs = require('fs');
const path = require('path');
const { getCollectionVariants, getProductsForListing, graphql } = require('./shopify');
const { mapProducts } = require('./listing');
const { getAyImageUrls } = require('./images');

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
const { updateStock, updatePrices, listProducts, getBrands, getAllProducts, updateProductStatus } = require('./aboutyou');
const { BRAND_MAP } = require('./listing');

// Country codes to sync prices for (e.g. "DE,AT,NL,BE")
const COUNTRY_CODES = (process.env.ABOUTYOU_COUNTRY_CODES || 'DE').split(',').map(c => c.trim());

async function syncStock() {
  console.log('[sync] Starting stock sync...');
  const variants = await getCollectionVariants(COLLECTION_HANDLE);

  const items = variants.map(v => ({
    sku: v.sku,
    // shippableQuantity excludes locations with shipsInventory: false (e.g. BB warehouse)
    quantity: Math.max(0, v.shippableQuantity ?? v.inventoryQuantity ?? 0),
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
//
// Important: only successfully mapped SKUs are added to known-skus.json.
// Products skipped due to a missing brand ID or image are left "unknown" so they are
// automatically retried on the next run (e.g. after a brand gets approved on AboutYou).
async function checkAndListNewProducts() {
  console.log('[sync] Checking for new products in collection...');

  // Get lightweight variant list to detect new SKUs quickly
  const variants = await getCollectionVariants(COLLECTION_HANDLE);
  const knownSkus = loadKnownSkus();
  const allCurrentSkus = new Set(variants.map(v => v.sku));

  const newSkus = new Set(variants.filter(v => !knownSkus.has(v.sku)).map(v => v.sku));

  if (newSkus.size === 0) {
    // Prune SKUs that were removed from the collection
    saveKnownSkus(new Set([...knownSkus].filter(s => allCurrentSkus.has(s))));
    console.log('[sync] No new products found.');
    return { newProducts: [] };
  }

  // Fetch full product data (images, options, description) for the collection
  const allProducts = await getProductsForListing(COLLECTION_HANDLE);

  // Keep only products that have at least one new SKU
  const newShopifyProducts = allProducts.filter(p =>
    p.variants.nodes.some(v => newSkus.has(v.sku))
  );

  console.log(`[sync] ${newSkus.size} new SKU(s) across ${newShopifyProducts.length} product(s): ${newShopifyProducts.map(p => p.title).join(', ')}`);

  // Process images to meet AY spec (3:4 portrait ≥1125×1500)
  for (const product of newShopifyProducts) {
    product._ayImageUrls = await getAyImageUrls(product, graphql);
  }

  // Map to AboutYou payload — products without a brand ID or image are skipped here
  const ayProducts = mapProducts(newShopifyProducts);

  // Only mark SKUs that were actually mapped as known; skipped ones stay unknown for retry
  const mappedSkus = new Set(ayProducts.map(item => item.sku));
  const skippedCount = newSkus.size - mappedSkus.size;
  if (skippedCount > 0) {
    console.log(`[sync] ${skippedCount} SKU(s) skipped (missing brand ID or image) — will retry next run`);
  }

  if (ayProducts.length > 0) {
    await listProducts(ayProducts);
    console.log('[sync] Product listing pushed to AboutYou.');
  }

  // Save: previously known SKUs still in collection + newly successfully mapped SKUs
  saveKnownSkus(new Set([
    ...[...knownSkus].filter(s => allCurrentSkus.has(s)),
    ...mappedSkus,
  ]));

  return { newProducts: newShopifyProducts.map(p => p.title) };
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

  // Process images to meet AY spec (3:4 portrait ≥1125×1500)
  console.log('[sync] Processing images...');
  for (const product of shopifyProducts) {
    product._ayImageUrls = await getAyImageUrls(product, graphql);
  }

  const ayProducts = mapProducts(shopifyProducts);
  console.log(`[sync] Listing ${ayProducts.length} product(s) on AboutYou...`);
  const batchResults = await listProducts(ayProducts);

  // Only mark successfully mapped SKUs as known so skipped ones are retried next incremental run
  const mappedSkus = new Set(ayProducts.map(item => item.sku));
  const knownSkus = loadKnownSkus();
  const allVariants = await getCollectionVariants(COLLECTION_HANDLE);
  const allCurrentSkus = new Set(allVariants.map(v => v.sku));
  saveKnownSkus(new Set([
    ...[...knownSkus].filter(s => allCurrentSkus.has(s)),
    ...mappedSkus,
  ]));

  const titles = ayProducts.map(p => p.name);
  console.log('[sync] Full listing complete.');
  return { listedProducts: titles, batchResults };
}

// Check AboutYou API for newly approved brands that match vendors in the Shopify collection.
// Logs actionable matches — brands that are approved on AY but not yet in BRAND_MAP.
async function checkNewBrands() {
  console.log('[sync] Checking for newly approved brands on AboutYou...');

  const [ayBrands, variants] = await Promise.all([
    getBrands(),
    getCollectionVariants(COLLECTION_HANDLE),
  ]);

  // Unique vendor names currently in the collection
  const vendorsInCollection = new Set(
    variants.map(v => v.product?.vendor).filter(Boolean)
  );

  // Vendors already mapped (case-insensitive)
  const knownVendors = new Set(Object.keys(BRAND_MAP).map(k => k.toLowerCase()));

  const newMatches = [];
  for (const brand of ayBrands) {
    if (!brand.id || !brand.name) continue;
    if (knownVendors.has(brand.name.toLowerCase())) continue; // already mapped

    const matchingVendor = [...vendorsInCollection].find(
      v => v.toLowerCase() === brand.name.toLowerCase()
    );
    if (!matchingVendor) continue;

    const variantCount = variants.filter(
      v => v.product?.vendor?.toLowerCase() === brand.name.toLowerCase()
    ).length;

    newMatches.push({ brand: brand.name, id: brand.id, vendor: matchingVendor, variantCount });
  }

  if (newMatches.length > 0) {
    console.log(`[sync] NEW BRANDS APPROVED ON ABOUTYOU (add to BUILTIN_BRAND_MAP in listing.js):`);
    for (const m of newMatches) {
      console.log(`  '${m.vendor}': ${m.id},  // ${m.variantCount} variant(s) in collection`);
    }
  } else {
    console.log('[sync] No new approved brands matching collection products.');
  }

  return newMatches;
}

// Submit all draft products on AboutYou for approval (status: draft → published,
// which AboutYou then shows as "pending approval" until reviewed).
async function submitDraftsForApproval() {
  console.log('[sync] Checking for draft products to submit for approval...');
  const ayProducts = await getAllProducts();
  const drafts = ayProducts.filter(p => p.status === 'draft');

  // Deduplicate by style_key
  const styleKeys = [...new Set(drafts.map(p => p.style_key).filter(Boolean))];
  if (styleKeys.length === 0) {
    console.log('[sync] No draft products found.');
    return { submitted: 0, styleKeys: [] };
  }

  const items = styleKeys.map(style_key => ({ style_key, status: 'published' }));
  const result = await updateProductStatus(items);
  console.log(`[sync] Submitted ${styleKeys.length} draft product(s) for approval.`);
  return { submitted: styleKeys.length, styleKeys, result };
}

module.exports = { syncStock, syncPrices, handleInventoryUpdate, handleProductUpdate, checkAndListNewProducts, listAllProducts, checkNewBrands, submitDraftsForApproval };
