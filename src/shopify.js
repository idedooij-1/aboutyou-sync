const axios = require('axios');

const client = axios.create({
  baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
});

// Fetch all product variants with SKU, price, and inventory
async function getAllVariants() {
  const variants = [];
  let cursor = null;

  do {
    const query = `
      query getVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            price
            compareAtPrice
            inventoryQuantity
            updatedAt
            product {
              id
              title
            }
          }
        }
      }
    `;

    const res = await client.post('/graphql.json', { query, variables: { cursor } });
    if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
    const page = res.data.data.productVariants;

    variants.push(...page.nodes.filter(v => v.sku && v.sku.trim() !== ''));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

// Fetch all variants from a specific collection (by handle), with SKU, price, and inventory
async function getCollectionVariants(handle) {
  const variants = [];
  let cursor = null;

  do {
    const query = `
      query getCollectionVariants($handle: String!, $cursor: String) {
        collection(handle: $handle) {
          title
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              variants(first: 100) {
                nodes {
                  id
                  sku
                  price
                  compareAtPrice
                  inventoryQuantity
                  updatedAt
                }
              }
            }
          }
        }
      }
    `;

    const res = await client.post('/graphql.json', { query, variables: { handle, cursor } });
    if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
    const collection = res.data.data.collection;

    if (!collection) {
      console.warn(`[shopify] Collection not found: "${handle}"`);
      break;
    }

    for (const product of collection.products.nodes) {
      for (const variant of product.variants.nodes) {
        if (variant.sku && variant.sku.trim() !== '') {
          variants.push({ ...variant, product: { id: product.id, title: product.title } });
        }
      }
    }

    cursor = collection.products.pageInfo.hasNextPage
      ? collection.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return variants;
}

module.exports = { getAllVariants, getCollectionVariants };
