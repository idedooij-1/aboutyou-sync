const axios = require('axios');

const client = axios.create({
  baseURL: 'https://partner.aboutyou.com/api/v1',
  headers: {
    'X-API-Key': process.env.ABOUTYOU_API_KEY,
    'Content-Type': 'application/json',
  },
});

// Sync stock for up to 1000 SKUs per call
async function updateStock(items) {
  const results = [];

  for (let i = 0; i < items.length; i += 1000) {
    const batch = items.slice(i, i + 1000);
    const res = await client.put('/products/stocks', { items: batch });
    results.push(res.data);
    console.log(`[aboutyou] Stock batch ${i / 1000 + 1}: batchRequestId=${res.data.batchRequestId}`);
  }

  return results;
}

// Sync prices for up to 1000 SKU/country combinations per call
async function updatePrices(items) {
  const results = [];

  for (let i = 0; i < items.length; i += 1000) {
    const batch = items.slice(i, i + 1000);
    const res = await client.put('/products/prices', { items: batch });
    results.push(res.data);
    console.log(`[aboutyou] Price batch ${i / 1000 + 1}: batchRequestId=${res.data.batchRequestId}`);
  }

  return results;
}

module.exports = { updateStock, updatePrices };
