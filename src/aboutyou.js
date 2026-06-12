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

// Upsert product variants on AboutYou.
// The API accepts up to 100 items per call and processes them asynchronously.
// Returns an array of batchRequestIds to poll via getProductBatchResults().
async function listProducts(variantItems) {
  const results = [];

  for (let i = 0; i < variantItems.length; i += 100) {
    const batch = variantItems.slice(i, i + 100);
    const res = await client.post('/products/', { items: batch });
    results.push(res.data);
    console.log(`[aboutyou] Listing batch ${Math.floor(i / 100) + 1}: batchRequestId=${res.data.batchRequestId}`);
  }

  return results;
}

// Poll the result of an async product batch request.
async function getProductBatchResults(batchRequestId) {
  const res = await client.get(`/products/batch-results/${batchRequestId}`);
  return res.data;
}

// Search categories by path fragment (e.g. "Sunglasses").
// Returns items: [{ id, name, path, parent_id, material_composition_type, parent }]
async function getCategories(query) {
  const res = await client.get('/categories/', { params: query ? { query } : {} });
  return res.data.items || [];
}

// List attribute groups (color, size options) for a given category ID.
async function getCategoryAttributeGroups(categoryId) {
  const res = await client.get(`/categories/${categoryId}/attribute-groups`);
  return res.data.attributes || [];
}

// List all brands available to this seller.
async function getBrands() {
  const res = await client.get('/brands/');
  return res.data.items || [];
}

module.exports = { updateStock, updatePrices, listProducts, getProductBatchResults, getCategories, getCategoryAttributeGroups, getBrands };
