/**
 * One-time OAuth setup to obtain a Shopify Admin API access token.
 *
 * After deploying to Railway:
 *   1. Visit  GET /auth/install  → redirects to Shopify for authorization
 *   2. Shopify redirects back to  GET /auth/callback?code=...
 *   3. The access token is shown on screen — copy it and set SHOPIFY_ACCESS_TOKEN in Railway env vars.
 *
 * Once SHOPIFY_ACCESS_TOKEN is set you no longer need these endpoints.
 */

const axios = require('axios');

function mountAuthRoutes(app) {
  const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
  const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
  const APP_URL = process.env.APP_URL; // e.g. https://your-app.railway.app

  // Step 1: Redirect to Shopify OAuth
  app.get('/auth/install', (req, res) => {
    if (!SHOPIFY_CLIENT_ID || !SHOPIFY_SHOP_DOMAIN || !APP_URL) {
      return res.status(500).send('Missing SHOPIFY_CLIENT_ID, SHOPIFY_SHOP_DOMAIN or APP_URL env vars');
    }
    const scopes = 'read_products,read_inventory';
    const redirectUri = `${APP_URL}/auth/callback`;
    const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize`
      + `?client_id=${SHOPIFY_CLIENT_ID}`
      + `&scope=${scopes}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(url);
  });

  // Step 2: Exchange code for access token
  app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    try {
      const response = await axios.post(
        `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
        {
          client_id: SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET,
          code,
        }
      );
      const token = response.data.access_token;
      res.send(`
        <h2>✅ Shopify connected!</h2>
        <p>Your access token (copy this into Railway as <code>SHOPIFY_ACCESS_TOKEN</code>):</p>
        <pre style="background:#f0f0f0;padding:12px;font-size:14px">${token}</pre>
        <p>Once the env var is set, restart the Railway service and this endpoint is no longer needed.</p>
      `);
    } catch (err) {
      res.status(500).send(`OAuth error: ${err.response?.data?.error_description || err.message}`);
    }
  });
}

module.exports = { mountAuthRoutes };
