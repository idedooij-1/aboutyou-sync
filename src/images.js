/**
 * images.js — AY-compliant image processor.
 *
 * AboutYou image requirements:
 *   - Minimum 1125 × 1500 px
 *   - Exactly 3:4 portrait ratio
 *   - At least 1 image per product
 *
 * Strategy (AboutYou only — Shopify is not touched):
 *   1. Download the original image from Shopify CDN.
 *   2. Pad to 3:4 portrait with a white background using sharp's "contain" fit
 *      — the original is never cropped, only canvas space is added.
 *   3. Resize to exactly 1125 × 1500 px.
 *   4. Save to public/images/ on this server.
 *   5. Return the public URL (SERVER_URL/images/<file>) for use in AY listings.
 *
 * Set SERVER_URL in .env (e.g. https://your-sync-server.com) so AY can fetch images.
 * Processed images are cached — already-processed images are not re-downloaded.
 */

const axios  = require('axios');
const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const AY_WIDTH  = 1125;
const AY_HEIGHT = 1500;

// Both images and cache live under data/ so a single Railway volume covers everything.
const DATA_DIR   = path.join(__dirname, '..', 'data');
const IMAGE_DIR  = path.join(DATA_DIR, 'images');
const CACHE_FILE = path.join(DATA_DIR, 'image-cache.json');

function ensureDirs() {
  [DATA_DIR, IMAGE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  ensureDirs();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Download the original image (without any Shopify CDN transform params).
 */
async function downloadImage(url) {
  const cleanUrl = url.split('?')[0];
  const res = await axios.get(cleanUrl, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

/**
 * Pad the image to 3:4 portrait with a white background — no cropping.
 * Output: JPEG at exactly 1125 × 1500 px.
 */
async function padTo34(buffer) {
  return sharp(buffer)
    .resize(AY_WIDTH, AY_HEIGHT, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Return AY-ready image URLs for a Shopify product.
 *
 * Pipeline per image:
 *   download → pad to 3:4 white (no crop) → 1125×1500 JPEG → saved to public/images/
 *   → served at SERVER_URL/images/<file>
 *
 * Results cached in data/image-cache.json.
 * Shopify is never modified.
 */
async function getAyImageUrls(product, _graphqlFn) {
  const imageNodes = product.images?.nodes || [];
  if (imageNodes.length === 0) return [];

  ensureDirs();

  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  if (!serverUrl) {
    console.warn('[images] SERVER_URL not set — AY image URLs will be relative paths');
  }

  const cache = loadCache();
  const urls  = [];

  for (const img of imageNodes) {
    const cacheKey = img.url.split('?')[0];
    const hash     = crypto.createHash('md5').update(cacheKey).digest('hex').slice(0, 8);
    const filename = `ay-${hash}.jpg`;
    const filepath = path.join(IMAGE_DIR, filename);
    const publicUrl = `${serverUrl}/images/${filename}`;

    // Use cache if the file already exists on disk
    if (cache[cacheKey] && fs.existsSync(filepath)) {
      console.log(`[images] cache hit: ${filename}`);
      urls.push(cache[cacheKey]);
      continue;
    }

    try {
      console.log(`[images] Processing: ${path.basename(cacheKey)}`);
      const raw    = await downloadImage(img.url);
      const padded = await padTo34(raw);
      fs.writeFileSync(filepath, padded);

      cache[cacheKey] = publicUrl;
      saveCache(cache);

      urls.push(publicUrl);
      console.log(`[images] ✓ Saved: ${filename}`);
    } catch (err) {
      console.error(`[images] ✗ "${product.title}" (${path.basename(cacheKey)}): ${err.message}`);
      urls.push(img.url); // fall back to original so listing isn't blocked
    }
  }

  console.log(`[images] "${product.title}": ${urls.length} image(s) processed`);
  return urls;
}

module.exports = { getAyImageUrls };
