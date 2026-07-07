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

// Brand IDs — known from Seller Center > Brands (GET /brands/ returns direct array)
const BUILTIN_BRAND_MAP = {
  'GUESS':            174728,
  'Guess':            174728,
  'Jimmy Choo':       176645,
  'Max Mara':         179312,
  'Fila':             176744,
  'Police':           175833,
  'Skechers':         174528,
  'Emilio Pucci':     178777,
  'Pucci':            178777, // same brand as Emilio Pucci
  'Bolle':            2617085,
  'Bollè':            2617085,
  // Newly approved brands (from AY /brands/ API 2026-06-30)
  'Timberland':       174266,
  'Tommy Hilfiger':   174564,
  'Ted Baker':        184336,
  'Tom Ford':         184370,
  'Victoria Beckham': 184430,
  'Marc Jacobs':      179290,
  'Tods':             3141709,
  "Tod's":            3141709,
  'Superdry':         4391023,
  // Newly activated brands (2026-07-01)
  'Converse':         174260,
  'Esprit':           174383,
  'Reebok':           174484,
  "O'Neill":          174513,
  'Omega':            176740,
  'Hugo':             177010,
  'Bally':            178454,
  'Gant':             178869,
  'Swarovski':        184312,
  'Michael Kors':     184837,
  'Hackett London':   304869,
  'Hackett':          304869,
  'Adidas Sport':     1107127,
  // Newly activated brands (2026-07-07)
  'Calvin Klein':     174588,
  'Scotch & Soda':    174605,
  'Carrera':          174640,
  'David Beckham':    181823,
  'Porsche Design':   281415,
  'Ana Hickmann':     4398548,
  'Serengeti':        4398549,
};

const BRAND_MAP = (() => {
  try { return { ...BUILTIN_BRAND_MAP, ...JSON.parse(process.env.ABOUTYOU_BRAND_MAP || '{}') }; }
  catch { return BUILTIN_BRAND_MAP; }
})();

// Category IDs — built-in defaults merged with ABOUTYOU_CATEGORY_MAP env var overrides
const BUILTIN_CATEGORY_MAP = { 'Sunglasses': 1445 };
const CATEGORY_MAP = (() => {
  try { return { ...BUILTIN_CATEGORY_MAP, ...JSON.parse(process.env.ABOUTYOU_CATEGORY_MAP || '{}') }; }
  catch { return BUILTIN_CATEGORY_MAP; }
})();

// Gender → category ID override.
// If a Shopify product has a tag matching a known gender, this takes priority over CATEGORY_MAP.
// Built-in: women → 1445, men → 1700
// Override/extend via ABOUTYOU_GENDER_CATEGORY_MAP e.g. '{"men":2000}'
const BUILTIN_GENDER_CATEGORY_MAP = { women: 1445, men: 1700 };
const GENDER_CATEGORY_MAP = (() => {
  try { return { ...BUILTIN_GENDER_CATEGORY_MAP, ...JSON.parse(process.env.ABOUTYOU_GENDER_CATEGORY_MAP || '{}') }; }
  catch { return BUILTIN_GENDER_CATEGORY_MAP; }
})();

// Detect gender from Shopify product tags.
// Recognises: "Women", "women", "gender:women", "gender_women", "female" → "women"
//             "Men",   "men",   "gender:men",   "gender_men",   "male"   → "men"
function detectGender(tags = []) {
  for (const tag of tags) {
    const t = tag.toLowerCase().replace(/[_:\s-]/g, '');
    if (t === 'women' || t === 'female' || t === 'genderwomen' || t === 'genderfemale') return 'women';
    if (t === 'men'   || t === 'male'   || t === 'gendermen'   || t === 'gendermale')   return 'men';
  }
  return null;
}

// Extract gender from product description HTML.
// Looks for "Gender Men" or "Gender Women" patterns commonly found in eyewear descriptions.
function extractGenderFromDescription(descriptionHtml) {
  const text = stripHtml(descriptionHtml);
  const match = text.match(/Gender\s+(Men|Women|Male|Female)/i);
  if (match) {
    const g = match[1].toLowerCase();
    if (g === 'men' || g === 'male') return 'men';
    if (g === 'women' || g === 'female') return 'women';
  }
  return null;
}

// Color and size attribute ID maps — set via env vars once you've looked up IDs per category
const COLOR_MAP = (() => {
  try { return JSON.parse(process.env.ABOUTYOU_COLOR_MAP || '{}'); }
  catch { return {}; }
})();

const SIZE_MAP = (() => {
  try { return JSON.parse(process.env.ABOUTYOU_SIZE_MAP || '{}'); }
  catch { return {}; }
})();

// Built-in color name → AboutYou attribute ID (category 1445, group id 1381)
// Covers common sunglass frame colors. Override/extend via ABOUTYOU_COLOR_NAME_MAP env var.
const BUILTIN_COLOR_NAME_MAP = {
  'black':        160515,
  'brown':        160381,
  'gold':         160413,
  'grey':         160415,
  'gray':         160415,
  'silver':       160518,
  'beige':        160344,
  'transparent':  160520,
  'clear':        160520,
  'white':        160521,
  'nude':         160346,
  'pink':         160476,
  'rose':         160478,
  'blue':         160357,
  'green':        160429,
  'red':          160510, // neon red — closest generic red
  'orange':       160471,
  'yellow':       160407,
  'purple':       160460,
  'olive':        160432,
  'havana':       160381, // tortoise/havana → brown
  'tortoise':     160381,
  'multicolor':   160463, // mischfarben / Mixed colours
  'multicolour':  160463,
  'multi':        160463,
  'mixed':        160463,
  'bronze':       160397,
  'copper':       160398,
  'cognac':       160386,
  'camel':        160347,
  'turquoise':    160360, // türkis
  'turquois':     160360,
  'teal':         160360,
  'petrol':       160433,
  'aqua':         160368,
  'mint':         160435,
  'cyan':         160372,
};
const COLOR_NAME_MAP = (() => {
  try { return { ...BUILTIN_COLOR_NAME_MAP, ...JSON.parse(process.env.ABOUTYOU_COLOR_NAME_MAP || '{}') }; }
  catch { return BUILTIN_COLOR_NAME_MAP; }
})();

// Default color and size for products without Color/Size variant options.
// Defaults: Black (160515) and Einheitsgröße/one-size (171501) for sunglasses.
// Override via ABOUTYOU_DEFAULT_COLOR_ID and ABOUTYOU_DEFAULT_SIZE_ID env vars.
const DEFAULT_COLOR_ID    = parseInt(process.env.ABOUTYOU_DEFAULT_COLOR_ID || '160515', 10); // Black
const DEFAULT_SIZE_ID     = parseInt(process.env.ABOUTYOU_DEFAULT_SIZE_ID  || '171501', 10); // Einheitsgröße

const SIZE_OPTION         = process.env.ABOUTYOU_SIZE_OPTION_NAME  || 'Size';
const COLOR_OPTION        = process.env.ABOUTYOU_COLOR_OPTION_NAME || 'Color';
const COUNTRY_OF_ORIGIN   = process.env.ABOUTYOU_COUNTRY_OF_ORIGIN || 'CN';
const DEFAULT_WEIGHT_GRAMS = parseInt(process.env.ABOUTYOU_DEFAULT_WEIGHT_GRAMS || '100', 10);

// Extract "Main color" from Shopify product description HTML and map to AY attribute ID.
// "Main color" is the primary color field for eyewear; "Frame color" is a fallback.
function extractColorFromDescription(descriptionHtml) {
  const text = stripHtml(descriptionHtml);
  // Prefer "Main color" — may be multi-word (e.g. "Main color Multicolor")
  const mainMatch = text.match(/Main colou?r\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
  if (mainMatch) {
    // Try the full two-word phrase first, then the first word alone
    const full = mainMatch[1].trim().toLowerCase();
    const first = full.split(/\s+/)[0];
    if (COLOR_NAME_MAP[full])  return COLOR_NAME_MAP[full];
    if (COLOR_NAME_MAP[first]) return COLOR_NAME_MAP[first];
  }
  // Frame color as secondary fallback
  const frameMatch = text.match(/Frame colou?r\s+([A-Za-z]+)/i);
  if (frameMatch) {
    const colorName = frameMatch[1].toLowerCase();
    if (COLOR_NAME_MAP[colorName]) return COLOR_NAME_MAP[colorName];
  }
  return undefined;
}

// Frame material detection for required AY attributes.
// shoe_material_style IDs (group 1716): Synthetik/Gummi=158865, Metall=180685
// material IDs (group 1396 — for material_composition_non_textile): Kunststoff=158715, Acetat=186647, Metall=186683
// cluster_id 164742 = "Rahmen" (Frame) from material_group_name group 1948
const FRAME_MATERIAL_MAP = {
  'plastic':    { shoeMatId: 158865, materialId: 158715 },
  'acetate':    { shoeMatId: 158865, materialId: 186647 },
  'metal':      { shoeMatId: 180685, materialId: 186683 },
  'stainless':  { shoeMatId: 180685, materialId: 186683 },
  'titanium':   { shoeMatId: 180685, materialId: 186683 },
  'aluminum':   { shoeMatId: 180685, materialId: 186683 },
  'aluminium':  { shoeMatId: 180685, materialId: 186683 },
  'nylon':      { shoeMatId: 158865, materialId: 158715 },
};
const DEFAULT_FRAME_MATERIAL = { shoeMatId: 158865, materialId: 158715 }; // Plastic

function extractFrameMaterial(descriptionHtml) {
  const text = stripHtml(descriptionHtml);
  const match = text.match(/Frame material\s+(\w+)/i);
  if (match) {
    const mat = match[1].toLowerCase();
    return FRAME_MATERIAL_MAP[mat] || DEFAULT_FRAME_MATERIAL;
  }
  return DEFAULT_FRAME_MATERIAL;
}

// Pad a 12-digit UPC barcode to 13-digit EAN-13 by prepending "0".
// Returns the barcode unchanged if it's already 13 digits or not a recognised UPC.
function normaliseEan(barcode) {
  if (!barcode) return undefined;
  const digits = barcode.replace(/\D/g, '');
  if (digits.length === 12) return '0' + digits;
  if (digits.length === 13) return digits;
  return digits.length >= 8 ? digits : undefined; // EAN-8 or unknown — pass through
}

function resolveBrandId(vendor) {
  // Case-insensitive lookup so "Guess" matches "GUESS" etc.
  const key = Object.keys(BRAND_MAP).find(k => k.toLowerCase() === (vendor || '').toLowerCase());
  const id = (key ? BRAND_MAP[key] : 0) || parseInt(process.env.ABOUTYOU_DEFAULT_BRAND_ID || '0', 10);
  if (!id) console.warn(`[listing] No brand ID for vendor "${vendor}". Set ABOUTYOU_BRAND_MAP or ABOUTYOU_DEFAULT_BRAND_ID.`);
  return id || undefined;
}

function resolveCategoryId(productType, tags = [], genderMetafield = null, descriptionHtml = '') {
  // custom.gender metafield takes highest priority (e.g. "Women" → "women")
  if (genderMetafield) {
    const g = genderMetafield.toLowerCase().trim();
    if (GENDER_CATEGORY_MAP[g]) return GENDER_CATEGORY_MAP[g];
  }
  // Tag-based detection
  const genderFromTags = detectGender(tags);
  if (genderFromTags && GENDER_CATEGORY_MAP[genderFromTags]) return GENDER_CATEGORY_MAP[genderFromTags];

  // Description-based detection (e.g. "Gender Men" in product description)
  const genderFromDesc = extractGenderFromDescription(descriptionHtml);
  if (genderFromDesc && GENDER_CATEGORY_MAP[genderFromDesc]) return GENDER_CATEGORY_MAP[genderFromDesc];

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

  // Resolve color: description "Main color" first → Shopify option (via COLOR_MAP) → default
  // "Main color" in the product description is the most reliable source for eyewear
  let colorId = extractColorFromDescription(shopifyProduct.descriptionHtml);
  if (!colorId && colorOption) {
    colorId = COLOR_MAP[colorOption.value];
    if (!colorId) {
      console.warn(`[listing] No color ID for option "${colorOption.value}". Add to ABOUTYOU_COLOR_MAP.`);
    }
  }
  if (!colorId) colorId = DEFAULT_COLOR_ID;

  // Resolve size: option map → default (one size for single-variant products)
  let sizeId = sizeOption ? SIZE_MAP[sizeOption.value] : undefined;
  if (sizeOption && !sizeId) {
    console.warn(`[listing] No size ID for option "${sizeOption.value}". Add to ABOUTYOU_SIZE_MAP.`);
  }
  if (!sizeId) sizeId = DEFAULT_SIZE_ID;

  // Prices: retail_price and optional sale_price in cents
  const prices = COUNTRY_CODES.map(country_code => {
    const retail_price = parseFloat(variant.compareAtPrice || variant.price);
    const sale_price   = variant.compareAtPrice ? parseFloat(variant.price) : undefined;
    return { country_code, retail_price, ...(sale_price !== undefined ? { sale_price } : {}) };
  });

  // Descriptions per language (reuse same text for all configured langs)
  const descText = stripHtml(shopifyProduct.descriptionHtml);
  const descriptions = {};
  for (const lang of DESC_LANGS) descriptions[lang] = descText;

  // Weight: prefer Shopify inventoryItem.measurement.weight, fall back to env default (100g)
  const shopifyWeight = variant.inventoryItem?.measurement?.weight;
  let weightGrams = 0;
  if (shopifyWeight && shopifyWeight.value > 0) {
    const u = (shopifyWeight.unit || '').toUpperCase();
    if (u === 'KILOGRAMS') weightGrams = Math.round(shopifyWeight.value * 1000);
    else if (u === 'POUNDS')    weightGrams = Math.round(shopifyWeight.value * 453.592);
    else if (u === 'OUNCES')    weightGrams = Math.round(shopifyWeight.value * 28.3495);
    else                        weightGrams = Math.round(shopifyWeight.value); // GRAMS
  }
  if (!weightGrams) weightGrams = DEFAULT_WEIGHT_GRAMS;

  // Resolve frame material for required AY category attributes
  const frameMaterial = extractFrameMaterial(shopifyProduct.descriptionHtml);

  const item = {
    style_key:          styleKey(shopifyProduct.id),
    sku:                variant.sku,
    ean:                normaliseEan(variant.barcode),
    name:               shopifyProduct.title,
    descriptions,
    brand:              resolveBrandId(shopifyProduct.vendor),
    category:           resolveCategoryId(shopifyProduct.productType, shopifyProduct.tags || [], shopifyProduct.metafield?.value || null, shopifyProduct.descriptionHtml || ''),
    quantity:           Math.max(0, variant.inventoryQuantity || 0),
    weight:             weightGrams || undefined,
    country_of_origin:  COUNTRY_OF_ORIGIN,
    countries:          COUNTRY_CODES,
    // Required category-specific attribute IDs (integers):
    //   186833 = quantity_per_pack: 1er Pack
    //   frameMaterial.shoeMatId = shoe_material_style: Plastic or Metal
    //   158747 = contains_non_textile_parts_of_animal_origin: nein
    attributes: [186833, frameMaterial.shoeMatId, 158747],
    // material_composition_non_textile: cluster 164742 = Rahmen (Frame)
    material_composition_non_textile: [
      { cluster_id: 164742, components: [{ material_id: frameMaterial.materialId, percentage: 100 }] },
    ],
    prices,
    images:             shopifyProduct._ayImageUrls || (shopifyProduct.images?.nodes || []).map(img => img.url),
  };

  item.color = colorId;
  item.size  = sizeId;

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

    // Pre-check required fields — skip entire product if brand or category can't be resolved
    const brandId    = resolveBrandId(product.vendor);
    const categoryId = resolveCategoryId(product.productType, product.tags || [], product.metafield?.value || null);
    if (!brandId) {
      console.warn(`[listing] Skipping "${product.title}" — no brand ID for vendor "${product.vendor}"`);
      continue;
    }
    if (!categoryId) {
      console.warn(`[listing] Skipping "${product.title}" — no category ID for product_type "${product.productType}"`);
      continue;
    }

    // Skip products with no images — AY requires at least one image per item
    // _ayImageUrls is pre-populated by sync.js after image processing
    const imageUrls = product._ayImageUrls || (product.images?.nodes || []).map(img => img.url);
    if (imageUrls.length === 0) {
      console.warn(`[listing] Skipping "${product.title}" — no images after processing (AY requires ≥1 image)`);
      continue;
    }

    for (const variant of variants) {
      items.push(mapVariantItem(product, variant));
    }
  }

  return items;
}

module.exports = { mapProducts, mapVariantItem, styleKey, BRAND_MAP };
