#!/usr/bin/env node
/**
 * delete-all-listings.js
 *
 * Deletes every product currently listed on AboutYou.
 *
 * Usage:
 *   node src/delete-all-listings.js          # dry run — shows what would be deleted
 *   node src/delete-all-listings.js --confirm # actually deletes
 *
 * Requires ABOUTYOU_API_KEY in the environment (or a .env file).
 */

require('dotenv').config();
const { getAllProducts, deleteProduct } = require('./aboutyou');

const DRY_RUN = !process.argv.includes('--confirm');

async function main() {
  if (DRY_RUN) {
    console.log('[delete-all] DRY RUN — pass --confirm to actually delete');
  } else {
    console.log('[delete-all] LIVE RUN — deleting all AboutYou listings');
  }

  console.log('[delete-all] Fetching all products from AboutYou...');
  const products = await getAllProducts();
  console.log(`[delete-all] Found ${products.length} products`);

  if (products.length === 0) {
    console.log('[delete-all] Nothing to delete.');
    return;
  }

  let deleted = 0;
  const errors = [];

  for (const p of products) {
    const label = `SKU ${p.sku} (${p.name || p.style_key || 'unknown'})`;

    if (DRY_RUN) {
      console.log(`[delete-all] would delete: ${label}`);
      continue;
    }

    try {
      await deleteProduct(p.sku);
      deleted++;
      console.log(`[delete-all] deleted ${deleted}/${products.length}: ${label}`);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      errors.push({ sku: p.sku, error: msg });
      console.error(`[delete-all] failed: ${label} — ${msg}`);
    }

    // Respect AboutYou rate limit
    await new Promise(r => setTimeout(r, 400));
  }

  if (DRY_RUN) {
    console.log(`\n[delete-all] Dry run complete. ${products.length} products would be deleted.`);
    console.log('[delete-all] Run with --confirm to proceed.');
  } else {
    console.log(`\n[delete-all] Done. ${deleted} deleted, ${errors.length} errors.`);
    if (errors.length) {
      console.error('[delete-all] Errors:', JSON.stringify(errors, null, 2));
    }
  }
}

main().catch(err => {
  console.error('[delete-all] Fatal:', err.message);
  process.exit(1);
});
