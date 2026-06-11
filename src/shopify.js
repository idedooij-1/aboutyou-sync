const axios = require('axios');

const client = axios.create({
  baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01`,
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
    const page = res.data.data.productVariants;

    variants.push(...page.nodes.filter(v => v.sku && v.sku.trim() !== ''));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

module.exports = { getAllVariants };
