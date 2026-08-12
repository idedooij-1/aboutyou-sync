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

// Resolve a collection handle to its GID
async function getCollectionId(handle) {
  const query = `
    query getCollectionId($query: String!) {
      collections(first: 1, query: $query) {
        nodes { id title }
      }
    }
  `;
  const res = await client.post('/graphql.json', { query, variables: { query: `handle:${handle}` } });
  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
  const nodes = res.data.data.collections.nodes;
  if (!nodes.length) throw new Error(`Collection not found: "${handle}"`);
  return nodes[0].id;
}

// Fetch all variants from a specific collection (by handle), with SKU, price, and inventory
async function getCollectionVariants(handle) {
  const collectionId = await getCollectionId(handle);
  const variants = [];
  let cursor = null;

  do {
    const query = `
      query getCollectionVariants($id: ID!, $cursor: String) {
        collection(id: $id) {
          title
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              vendor
              variants(first: 100) {
                nodes {
                  id
                  sku
                  price
                  compareAtPrice
                  inventoryQuantity
                  updatedAt
                  inventoryItem {
                    inventoryLevels(first: 10) {
                      nodes {
                        location { shipsInventory }
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const res = await client.post('/graphql.json', { query, variables: { id: collectionId, cursor } });
    if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
    const collection = res.data.data.collection;

    if (!collection) {
      console.warn(`[shopify] Collection not found: "${handle}"`);
      break;
    }

    for (const product of collection.products.nodes) {
      for (const variant of product.variants.nodes) {
        if (variant.sku && variant.sku.trim() !== '') {
          // Only count stock at locations that actually ship inventory —
          // excludes non-fulfilling locations (e.g. BB warehouse) from the AboutYou stock feed
          const levels = (variant.inventoryItem && variant.inventoryItem.inventoryLevels && variant.inventoryItem.inventoryLevels.nodes) || [];
          const shippableQuantity = levels
            .filter(l => l.location && l.location.shipsInventory)
            .reduce((sum, l) => {
              const available = (l.quantities || []).find(q => q.name === 'available');
              return sum + (available ? available.quantity : 0);
            }, 0);

          variants.push({ ...variant, shippableQuantity, product: { id: product.id, title: product.title, vendor: product.vendor } });
        }
      }
    }

    cursor = collection.products.pageInfo.hasNextPage
      ? collection.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return variants;
}

// Fetch full product data for listing on AboutYou (title, description, images, variants with options/barcode)
async function getProductsForListing(handle) {
  const collectionId = await getCollectionId(handle);
  const products = [];
  let cursor = null;

  do {
    const query = `
      query getProductsForListing($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              descriptionHtml
              vendor
              productType
              tags
              options { name values }
              metafield(namespace: "custom", key: "gender") { value }
              images(first: 10) {
                nodes { url altText }
              }
              variants(first: 100) {
                nodes {
                  id
                  sku
                  barcode
                  price
                  compareAtPrice
                  inventoryQuantity
                  inventoryItem { measurement { weight { value unit } } }
                  updatedAt
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    `;

    const res = await client.post('/graphql.json', { query, variables: { id: collectionId, cursor } });
    if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
    const collection = res.data.data.collection;

    if (!collection) {
      console.warn(`[shopify] Collection not found: "${handle}"`);
      break;
    }

    products.push(...collection.products.nodes);
    cursor = collection.products.pageInfo.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (cursor);

  return products;
}

// Fetch specific products by their Shopify GIDs (for targeted re-listing)
async function getProductsByIds(productGids) {
  if (!productGids || productGids.length === 0) return [];

  const query = `
    query getProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          descriptionHtml
          vendor
          productType
          tags
          options { name values }
          metafield(namespace: "custom", key: "gender") { value }
          images(first: 10) {
            nodes { url altText }
          }
          variants(first: 100) {
            nodes {
              id
              sku
              barcode
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem { measurement { weight { value unit } } }
              updatedAt
              selectedOptions { name value }
            }
          }
        }
      }
    }
  `;

  const res = await client.post('/graphql.json', { query, variables: { ids: productGids } });
  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
  // Filter out nulls (non-Product nodes) and return the products
  return (res.data.data.nodes || []).filter(n => n && n.id);
}

// Raw GraphQL helper — for use by other modules (e.g. images.js for staged uploads)
async function graphql(query, variables = {}) {
  const res = await client.post('/graphql.json', { query, variables });
  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join('; '));
  return res.data.data;
}

module.exports = { getAllVariants, getCollectionVariants, getProductsForListing, getProductsByIds, graphql };
