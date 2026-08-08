#!/usr/bin/env node
/**
 * list-all.js — Push all products in the Shopify "aboutyou" collection to AboutYou.
 *
 * Usage:
 *   node src/list-all.js
 *
 * Requires ABOUTYOU_API_KEY, SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN in .env
 */

require('dotenv').config();
const { listAllProducts } = require('./sync');

listAllProducts()
  .then(result => {
    console.log(`\n[list-all] Done. ${result.listedProducts?.length ?? 0} product(s) listed.`);
    if (result.listedProducts?.length) {
      console.log(result.listedProducts.join('\n'));
    }
  })
  .catch(err => {
    console.error('[list-all] Fatal:', err.response?.data || err.message);
    process.exit(1);
  });
