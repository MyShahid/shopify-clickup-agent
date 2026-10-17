// test.js — checks that Shopify, ClickUp and Claude all connect.
// Run from the project folder:  node test.js
require('dotenv').config();
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const {
  SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
  CLICKUP_TOKEN, CLICKUP_LIST_ID, ANTHROPIC_API_KEY,
} = process.env;

const SHOP = `https://${SHOPIFY_STORE}.myshopify.com`;
const API_VERSION = '2026-10';

async function testShopify() {
  // 1. Get a short-lived access token (client credentials grant)
  const tokenRes = await fetch(`${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error('Token failed: ' + JSON.stringify(tokenJson));

  // 2. Read the first 5 products
  const res = await fetch(`${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenJson.access_token,
    },
    body: JSON.stringify({
      query: `{ products(first: 5) { nodes { title variants(first: 1) { nodes { price } } } } }`,
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  console.log('✅ Shopify OK. Products:');
  for (const p of json.data.products.nodes) {
    console.log(`   - ${p.title}  (${p.variants.nodes[0]?.price})`);
  }
}

async function testClickUp() {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
    headers: { Authorization: CLICKUP_TOKEN },
  });
  const json = await res.json();
  if (!json.tasks) throw new Error(JSON.stringify(json));
  console.log('✅ ClickUp OK. Tasks:');
  for (const t of json.tasks) console.log(`   - [${t.status.status}] ${t.name}`);
}

async function testClaude() {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'Reply with just: connected' }],
  });
  console.log('✅ Claude OK. Reply:', msg.content[0].text);
}

(async () => {
  for (const [name, fn] of [['Shopify', testShopify], ['ClickUp', testClickUp], ['Claude', testClaude]]) {
    try { await fn(); } catch (e) { console.log(`❌ ${name} failed:`, e.message); }
  }
})();