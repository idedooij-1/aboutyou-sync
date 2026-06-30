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
    try {
      const res = await client.post('/products/', { items: batch });
      results.push(res.data);
      console.log(`[aboutyou] Listing batch ${Math.floor(i / 100) + 1}: batchRequestId=${res.data.batchRequestId}`);
    } catch (err) {
      const body = err.response?.data;
      console.error(`[aboutyou] Batch ${Math.floor(i / 100) + 1} failed ${err.response?.status}: ${JSON.stringify(body)}`);
      console.error(`[aboutyou] First item payload: ${JSON.stringify(batch[0])}`);
      throw err;
    }
  }

  return results;
}

// Poll the result of an async product batch request.
async function getProductBatchResults(batchRequestId) {
  const res = await client.get('/results/products', { params: { batch_request_id: batchRequestId } });
  return res.data;
}

// List rejected products (async processing failures), optionally filtered by style_key.
async function getRejectedProducts(styleKey) {
  const params = styleKey ? { style_key: styleKey } : {};
  const res = await client.get('/products/rejected', { params });
  return res.data;
}

// Search categories by path fragment (e.g. "Sunglasses").
// Returns items: [{ id, name, path, parent_id, material_composition_type, parent }]
async function getCategories(query) {
  const res = await client.get('/categories/', { params: query ? { query } : {} });
  return res.data.items || [];
}

// List attribute groups (color, size options) for a given category ID.
// Response is a top-level array of groups, each with { id, name, attributes: [{id, name}] }
async function getCategoryAttributeGroups(categoryId) {
  const res = await client.get(`/categories/${categoryId}/attribute-groups`);
  return Array.isArray(res.data) ? res.data : [];
}

// List all brands available to this seller.
// AY returns a direct array (not {items:[...]}).
async function getBrands() {
  const res = await client.get('/brands/');
  return Array.isArray(res.data) ? res.data : (res.data.items || []);
}

// Fetch one page of products from AboutYou (page_size default on API side).
async function getProducts(page = 1) {
  const res = await client.get('/products/', { params: { page } });
  return res.data; // { items: [...], pagination: { page, pages, total, ... } }
}

// Fetch ALL products from AboutYou by paginating through all pages.
async function getAllProducts() {
  const all = [];
  let page = 1;
  let totalPages = null;

  do {
    const data = await getProducts(page);
    all.push(...(data.items || []));
    totalPages = data.pagination?.pages ?? null;
    page++;
  } while (totalPages !== null && page <= totalPages);

  return all;
}

// Delete a single product variant from AboutYou by SKU.
async function deleteProduct(sku) {
  const res = await client.delete(`/products/${encodeURIComponent(sku)}`);
  return res.data;
}

// Update the status of products by style_key.
// status: 'published' (submit for approval), 'draft', or 'inactive'
async function updateProductStatus(items) {
  const res = await client.put('/products/status', { items });
  return res.data;
}

module.exports = { updateStock, updatePrices, listProducts, getProductBatchResults, getRejectedProducts, getCategories, getCategoryAttributeGroups, getBrands, getProducts, getAllProducts, deleteProduct, updateProductStatus };
