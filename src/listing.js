/**
 * listing.js — Maps Shopify products to the AboutYou flat variant-level upsert payload.
 *
 * AboutYou API structure (POST /api/v1/products/):
 *   { items: [ <one object per variant> ] }
 *
 * Each item represents ONE variant. The `style_key` field groups variants under
 * the same product master on AboutYou (equivalent to Shopify's product).
 *
 * Numeric IDs required by AboutYou:
 *   - category:  GET /api/v1/categories/?query=<name>  → id
 *   - brand:     Known from Seller Center > Brands
 *   - color:     GET /api/v1/categories/<category_id>/attribute-groups → attributes[name=color]
 *   - size:      Same attribute-groups endpoint → attributes[name=size]
 *
 * Known brand IDs (from Seller Center > Brands):
 *   GUESS      → 174728
 *   Jimmy Choo → 176645
 *   Max Mara   → 179312
 *
 * Configure via environment variables:
 *   ABOUTYOU_BRAND_MAP         — JSON: { "Shopify vendor": brandId }
 *                                e.g. '{"GUESS":174728,"Jimmy Choo":176645,"Max Mara":179312}'
 *   ABOUTYOU_DEFAULT_BRAND_ID  — fallback brand ID
 *   ABOUTYOU_CATEGORY_MAP      — JSON: { "Shopify product_type": categoryId }
 *                                e.g. '{"Sunglasses":12345}'
 *   ABOUTYOU_COLOR_MAP         — JSON: { "Shopify color value": aboutYouColorId }
 *   ABOUTYOU_SIZE_MAP          — JSON: { "Shopify size value": aboutYouSizeId }
 *   ABOUTYOU_COUNTRY_CODES     — comma-separated, e.g. "DE,NL"
 *   ABOUTYOU_SIZE_OPTION_NAME  — Shopify option name for size (default: "Size")
 *   ABOUTYOU_COLOR_OPTION_NAME — Shopify option name for color (default: "Color")
 *   ABOUTYOU_DESCRIPTION_LANG  — comma-separated language codes for descriptions (default: "de,en")
 */

const COUNTRY_CODES = (process.env.ABOUTYOU_COUNTRY_CODES || 'DE').split(',').map(c => c.trim());
const DESC_LANGS = (process.env.ABOUTYOU_DESCRIPTION_LANG || 'de,en').split(',').map(l => l.trim());

// Brand IDs — known from Seller Center > Brands
const BUILTIN_BRAND_MAP = {
  'GUESS':      174728,
  'Jimmy Choo': 176645,
  'Max Mara':   179312,
};

const BRAND_MAP = (() => {
  try { return { ...BUILTIN_BRAND_MAP, ...JSON.parse(process.env.ABOUTYOU_BRAND_MAP || '{}') }; }
  catch { return BUILTIN_BRAND_MAP; }
})();

// Category IDs — set via ABOUTYOU_CATEGORY_MAP env var
// e.g. '{"Sunglasses":12345}'
// Use GET /api/v1/categories/?query=Sunglasses to find the correct ID for your account.
const CATEGORY_MAP = (() => {
  try { return JSON.parse(process.env.ABOUTYOU_CATEGORY_MAP || '{}'); }
  catch { return {}; }
})();

// Color and size attribute ID maps — set via env vars once you've looked up IDs per category
const COLOR_MAP = (() => {
  try { return JSON.parse(process.env.ABOUTYOU_COLOR_MAP || '{}'); }
  catch { return {}; }
})();

const SIZE_MAP = (() => {
  try { return JSON.parse(process.env.ABOUTYOU_SIZE_MAP || '{}'); }
  catch { return {}; }
})();

const SIZE_OPTION  = process.env.ABOUTYOU_SIZE_OPTION_NAME  || 'Size';
const COLOR_OPTION = process.env.ABOUTYOU_COLOR_OPTION_NAME || 'Color';

function resolveBrandId(vendor) {
  const id = BRAND_MAP[vendor] || parseInt(process.env.ABOUTYOU_DEFAULT_BRAND_ID || '0', 10);
  if (!id) console.warn(`[listing] No brand ID for vendor "${vendor}". Set ABOUTYOU_BRAND_MAP or ABOUTYOU_DEFAULT_BRAND_ID.`);
  return id || undefined;
}

function resolveCategoryId(productType) {
  const id = CATEGORY_MAP[productType] || parseInt(process.env.ABOUTYOU_DEFAULT_CATEGORY_ID || '0', 10);
  if (!id) console.warn(`[listing] No category ID for product_type "${productType}". Set ABOUTYOU_CATEGORY_MAP or ABOUTYOU_DEFAULT_CATEGORY_ID.`);
  return id || undefined;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Build a short, stable style_key from a Shopify product GID
// "gid://shopify/Product/123456789" → "shopify-123456789"
function styleKey(shopifyProductId) {
  const numeric = shopifyProductId.split('/').pop();
  return `shopify-${numeric}`;
}

/**
 * Map a single Shopify product + one of its variants to an AboutYou item payload.
 * AboutYou expects one flat object per variant, grouped by style_key.
 */
function mapVariantItem(shopifyProduct, variant) {
  const selectedOptions = variant.selectedOptions || [];
  const colorOption = selectedOptions.find(o => o.name === COLOR_OPTION);
  const sizeOption  = selectedOptions.find(o => o.name === SIZE_OPTION);

  const colorId = colorOption ? COLOR_MAP[colorOption.value] : undefined;
  const sizeId  = sizeOption  ? SIZE_MAP[sizeOption.value]   : undefined;

  if (colorOption && !colorId) {
    console.warn(`[listing] No color ID for "${colorOption.value}". Add to ABOUTYOU_COLOR_MAP.`);
  }
  if (sizeOption && !sizeId) {
    console.warn(`[listing] No size ID for "${sizeOption.value}". Add to ABOUTYOU_SIZE_MAP.`);
  }

  // Prices: retail_price and optional sale_price in cents
  const prices = COUNTRY_CODES.map(country_code => {
    const retail_price = Math.round(parseFloat(variant.compareAtPrice || variant.price) * 100);
    const sale_price   = variant.compareAtPrice ? Math.round(parseFloat(variant.price) * 100) : undefined;
    return { country_code, retail_price, ...(sale_price !== undefined ? { sale_price } : {}) };
  });

  // Descriptions per language (reuse same text for all configured langs)
  const descText = stripHtml(shopifyProduct.descriptionHtml);
  const descriptions = {};
  for (const lang of DESC_LANGS) descriptions[lang] = descText;

  const item = {
    style_key: styleKey(shopifyProduct.id),
    sku:       variant.sku,
    name:      shopifyProduct.title,
    descriptions,
    brand:     resolveBrandId(shopifyProduct.vendor),
    category:  resolveCategoryId(shopifyProduct.productType),
    quantity:  Math.max(0, variant.inventoryQuantity || 0),
    countries: COUNTRY_CODES,
    prices,
    images:    (shopifyProduct.images?.nodes || []).map(img => img.url),
  };

  if (variant.barcode) item.ean = variant.barcode;
  if (colorId)         item.color = colorId;
  if (sizeId)          item.size  = sizeId;

  // Remove undefined top-level fields
  Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);

  return item;
}

/**
 * Map an array of full Shopify products to a flat list of AboutYou variant items.
 * Skips variants without a SKU.
 */
function mapProducts(shopifyProducts) {
  const items = [];

  for (const product of shopifyProducts) {
    const variants = (product.variants?.nodes || []).filter(v => v.sku && v.sku.trim());
    if (variants.length === 0) {
      console.warn(`[listing] Skipping "${product.title}" — no variants with SKUs`);
      continue;
    }
    for (const variant of variants) {
      items.push(mapVariantItem(product, variant));
    }
  }

  return items;
}

module.exports = { mapProducts, mapVariantItem, styleKey };
