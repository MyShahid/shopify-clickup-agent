// agent.js — ClickUp → Claude agent → Shopify → back to ClickUp (with human review loop)
// Run from the project folder:  node agent.js
require('dotenv').config();
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const {
  SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
  CLICKUP_TOKEN, CLICKUP_LIST_ID, ANTHROPIC_API_KEY,
} = process.env;

const SHOP = `https://${SHOPIFY_STORE}.myshopify.com`;
const API_VERSION = '2026-10';
const MODEL = 'claude-sonnet-5-5';
const POLL_MS = 10000;
const AGENT_TAG = '🤖 Agent';

const STATUS = {
  todo: 'to do',
  working: 'agent working',
  review: 'needs review',
  done: 'done',
};

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* ---------------- Shopify ---------------- */

let shopifyToken = null;
let shopifyTokenAt = 0;

async function getShopifyToken() {
  // Client-credentials tokens last 24h; refresh every 20h to be safe
  if (shopifyToken && Date.now() - shopifyTokenAt < 20 * 3600 * 1000) return shopifyToken;
  const res = await fetch(`${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Shopify token failed: ' + JSON.stringify(json));
  shopifyToken = json.access_token;
  shopifyTokenAt = Date.now();
  return shopifyToken;
}

async function shopifyGQL(query, variables = {}) {
  const token = await getShopifyToken();
  const res = await fetch(`${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const numericId = (gid) => gid.split('/').pop();

/* ---------------- Tools the agent can use ---------------- */

const tools = [
  {
    name: 'list_products',
    description: 'List products in the Shopify store with their IDs, handles and variants (variant IDs, titles, prices).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_variant_price',
    description: 'Change the price of one product variant.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product GID, e.g. gid://shopify/Product/123' },
        variant_id: { type: 'string', description: 'Variant GID, e.g. gid://shopify/ProductVariant/456' },
        new_price: { type: 'string', description: 'New price as a string, e.g. "25.00"' },
      },
      required: ['product_id', 'variant_id', 'new_price'],
    },
  },
  {
    name: 'update_product_details',
    description: 'Change a product title and/or description (HTML).',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        title: { type: 'string' },
        description_html: { type: 'string' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'list_themes',
    description: 'List the store themes with their IDs, names and roles (MAIN = live, UNPUBLISHED = safe to edit).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_theme_files',
    description: 'List file names in a theme (e.g. sections/header.liquid, templates/index.json).',
    input_schema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string' },
        pattern: { type: 'string', description: 'Optional filter like "sections/*" or "templates/*"' },
      },
      required: ['theme_id'],
    },
  },
  {
    name: 'search_theme_files',
    description: 'Search the text of theme files (sections, templates, snippets, blocks, config, layout) and return matching lines with file names.',
    input_schema: {
      type: 'object',
      properties: { theme_id: { type: 'string' }, text: { type: 'string' } },
      required: ['theme_id', 'text'],
    },
  },
  {
    name: 'read_theme_file',
    description: 'Read the full content of one theme file.',
    input_schema: {
      type: 'object',
      properties: { theme_id: { type: 'string' }, filename: { type: 'string' } },
      required: ['theme_id', 'filename'],
    },
  },
  {
    name: 'edit_theme_file',
    description: 'Edit a theme file by replacing an exact piece of text. old_text must appear exactly once in the file. Only works on UNPUBLISHED themes.',
    input_schema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string' },
        filename: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['theme_id', 'filename', 'old_text', 'new_text'],
    },
  },
  {
    name: 'create_theme_file',
    description: 'Create a NEW theme file (e.g. a new section). Fails if the file already exists. Only works on UNPUBLISHED themes.',
    input_schema: {
      type: 'object',
      properties: { theme_id: { type: 'string' }, filename: { type: 'string' }, content: { type: 'string' } },
      required: ['theme_id', 'filename', 'content'],
    },
  },
];

const productLinks = (productId, handle) => [
  `Admin: https://admin.shopify.com/store/${SHOPIFY_STORE}/products/${numericId(productId)}`,
  `Store: ${SHOP}/products/${handle}`,
];
const themeLinks = (themeId) => [
  `Preview: ${SHOP}/?preview_theme_id=${numericId(themeId)}`,
  `Theme editor: https://admin.shopify.com/store/${SHOPIFY_STORE}/themes/${numericId(themeId)}/editor`,
];

/* ---------------- Theme helpers ---------------- */

async function getTheme(themeId) {
  const d = await shopifyGQL(`query($id: ID!) { theme(id: $id) { id name role } }`, { id: themeId });
  if (!d.theme) throw new Error('Theme not found: ' + themeId);
  return d.theme;
}

// Hard safety rule in code (not just in the prompt): never write to the live theme
async function assertSafeTheme(themeId) {
  const t = await getTheme(themeId);
  if (t.role === 'MAIN') throw new Error(`Refusing to edit the LIVE theme "${t.name}". Edit an unpublished copy instead.`);
  if (!t.name.toLowerCase().includes('agent preview')) throw new Error(`Refusing to edit "${t.name}". Only the "Agent Preview" theme may be edited.`);
  return t;
}

// Theme files are edited through Shopify CLI (theme pull/push), because the Admin API
// theme-file mutation needs a special exemption from Shopify.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const THEME_DIR = path.join(__dirname, 'theme-preview');
let pulledThemeId = null; // reset at the start of every agent run

function cli(args) {
  try {
    return execSync(`shopify ${args} --store ${SHOPIFY_STORE}.myshopify.com`, {
      stdio: 'pipe', timeout: 5 * 60 * 1000, encoding: 'utf8',
    });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().slice(-800);
    throw new Error('Shopify CLI failed: ' + msg);
  }
}

function ensurePulled(themeId) {
  if (pulledThemeId === themeId) return;
  console.log('   ⬇️  Pulling theme files...');
  fs.rmSync(THEME_DIR, { recursive: true, force: true });
  fs.mkdirSync(THEME_DIR, { recursive: true }); // Shopify CLI needs the folder to exist
  cli(`theme pull --theme ${numericId(themeId)} --path "${THEME_DIR}"`);
  pulledThemeId = themeId;
}

function pushFile(themeId, filename) {
  console.log(`   ⬆️  Pushing ${filename}...`);
  cli(`theme push --theme ${numericId(themeId)} --path "${THEME_DIR}" --only ${filename} --nodelete`);
}

function safePath(filename) {
  if (!/^[\w\-./]+$/.test(filename)) throw new Error('Invalid filename');
  const full = path.resolve(THEME_DIR, filename);
  if (!full.startsWith(path.resolve(THEME_DIR) + path.sep)) throw new Error('Invalid filename');
  return full;
}

function readThemeFile(themeId, filename) {
  ensurePulled(themeId);
  const full = safePath(filename);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function writeThemeFile(themeId, filename, content) {
  const full = safePath(filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  pushFile(themeId, filename);
}

function listLocalFiles(dir = THEME_DIR, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listLocalFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const short = (t) => (t.length > 300 ? t.slice(0, 300) + '…' : t);

// Every change is recorded here so we can post a before/after diff to ClickUp
let changeLog = [];

async function runTool(name, input) {
  if (name === 'list_products') {
    const data = await shopifyGQL(`{
      products(first: 50) { nodes {
        id title handle status
        variants(first: 10) { nodes { id title price } }
      } }
    }`);
    return data.products.nodes;
  }

  if (name === 'update_variant_price') {
    const before = await shopifyGQL(
      `query($id: ID!) { productVariant(id: $id) { price product { title handle } } }`,
      { id: input.variant_id },
    );
    const data = await shopifyGQL(
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
      { productId: input.product_id, variants: [{ id: input.variant_id, price: input.new_price }] },
    );
    const r = data.productVariantsBulkUpdate;
    if (r.userErrors.length) return { error: r.userErrors };
    const v = before.productVariant;
    changeLog.push({
      what: `Price — ${v.product.title}`,
      before: v.price,
      after: r.productVariants[0].price,
      links: productLinks(input.product_id, v.product.handle),
    });
    return { ok: true, before: v.price, after: r.productVariants[0].price };
  }

  if (name === 'update_product_details') {
    const before = await shopifyGQL(
      `query($id: ID!) { product(id: $id) { title handle descriptionHtml } }`,
      { id: input.product_id },
    );
    const product = { id: input.product_id };
    if (input.title) product.title = input.title;
    if (input.description_html) product.descriptionHtml = input.description_html;
    const data = await shopifyGQL(
      `mutation($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { title handle descriptionHtml }
          userErrors { field message }
        }
      }`,
      { product },
    );
    const r = data.productUpdate;
    if (r.userErrors.length) return { error: r.userErrors };
    const b = before.product;
    const links = productLinks(input.product_id, r.product.handle);
    if (input.title) changeLog.push({ what: 'Title', before: b.title, after: r.product.title, links });
    if (input.description_html) changeLog.push({ what: `Description — ${r.product.title}`, before: strip(b.descriptionHtml), after: strip(r.product.descriptionHtml), links });
    return { ok: true };
  }

  if (name === 'list_themes') {
    const d = await shopifyGQL(`{ themes(first: 20) { nodes { id name role } } }`);
    return d.themes.nodes;
  }

  if (name === 'list_theme_files') {
    ensurePulled(input.theme_id);
    let files = listLocalFiles();
    if (input.pattern) {
      const prefix = input.pattern.replace('*', '');
      files = files.filter((f) => f.startsWith(prefix));
    }
    return files;
  }

  if (name === 'search_theme_files') {
    ensurePulled(input.theme_id);
    const needle = input.text.toLowerCase();
    const hits = [];
    for (const f of listLocalFiles()) {
      if (!/\.(liquid|json|css|js)$/.test(f)) continue;
      const content = fs.readFileSync(safePath(f), 'utf8');
      content.split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 200) });
      });
      if (hits.length >= 50) break;
    }
    return hits.length ? hits.slice(0, 50) : 'No matches.';
  }

  if (name === 'read_theme_file') {
    const content = readThemeFile(input.theme_id, input.filename);
    if (content === null) return { error: 'File not found' };
    return content.length > 40000 ? content.slice(0, 40000) + '\n…(truncated)' : content;
  }

  if (name === 'edit_theme_file') {
    const theme = await assertSafeTheme(input.theme_id);
    const content = readThemeFile(input.theme_id, input.filename);
    if (content === null) return { error: 'File not found' };
    const count = content.split(input.old_text).length - 1;
    if (count !== 1) return { error: `old_text must appear exactly once, found ${count} times. Read the file and use a longer, unique snippet.` };
    writeThemeFile(input.theme_id, input.filename, content.replace(input.old_text, () => input.new_text));
    changeLog.push({
      what: `Theme "${theme.name}" — ${input.filename}`,
      before: short(input.old_text),
      after: short(input.new_text),
      links: themeLinks(input.theme_id),
    });
    return { ok: true };
  }

  if (name === 'create_theme_file') {
    const theme = await assertSafeTheme(input.theme_id);
    if (readThemeFile(input.theme_id, input.filename) !== null) return { error: 'File already exists. Use edit_theme_file.' };
    writeThemeFile(input.theme_id, input.filename, input.content);
    changeLog.push({
      what: `Theme "${theme.name}" — new file ${input.filename}`,
      before: '(none)',
      after: `${input.content.split('\n').length} lines`,
      links: themeLinks(input.theme_id),
    });
    return { ok: true };
  }

  return { error: `Unknown tool ${name}` };
}

const strip = (html) => (html || '').replace(/<[^>]+>/g, '').slice(0, 200) || '(empty)';

/* ---------------- The agent loop ---------------- */

const SYSTEM = `You are an agent that completes Shopify store tasks from a project management tool.
General:
- Make exactly the change requested. Do not change anything else.
- If the request is ambiguous or you cannot find what it refers to, make NO changes and explain what you need.
- When finished, reply with a short plain-text summary (2-4 lines) of what you did.
Admin tasks (products, prices, descriptions): use the product tools.
Theme tasks (text, sections, styling, Liquid):
- NEVER edit the live theme (role MAIN). Always work on the UNPUBLISHED theme whose name contains "Agent Preview".
  If there is none, make no changes and say an "Agent Preview" theme copy is needed.
- Find the right file with search_theme_files / list_theme_files, read it, then use edit_theme_file with a small, unique old_text.
- Keep Liquid and JSON valid. For JSON templates, edit only the needed value.
- The reviewer approves by publishing the preview theme, so mention that in your summary.`;

async function runAgent(instruction) {
  changeLog = [];
  pulledThemeId = null; // always start from a fresh copy of the theme
  const messages = [{ role: 'user', content: instruction }];

  for (let step = 0; step < 25; step++) {
    const res = await claude.messages.create({
      model: MODEL, max_tokens: 8000, system: SYSTEM, tools, messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }

    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`   🔧 ${block.name}`, JSON.stringify(block.input));
      let out;
      try { out = await runTool(block.name, block.input); } catch (e) { out = { error: e.message }; }
      if (out && out.error) console.log('      ⚠️ ', JSON.stringify(out.error).slice(0, 300));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Stopped: too many steps.';
}

/* ---------------- ClickUp ---------------- */

async function clickup(path, method = 'GET', body) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    method,
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const getTasks = () => clickup(`/list/${CLICKUP_LIST_ID}/task?include_closed=false`).then((j) => j.tasks || []);
const setStatus = (id, status) => clickup(`/task/${id}`, 'PUT', { status });
// Remember every comment the agent posts or has already handled, so it never replies to itself
const handledComments = new Set();
const addComment = async (id, text) => {
  const r = await clickup(`/task/${id}/comment`, 'POST', { comment_text: text, notify_all: false });
  if (r && r.id) handledComments.add(String(r.id));
  return r;
};
const getComments = (id) => clickup(`/task/${id}/comment`).then((j) => j.comments || []);

function buildReport(summary) {
  let text = `${AGENT_TAG}\n\n${summary}\n`;
  if (changeLog.length) {
    text += `\nChanges:\n`;
    for (const c of changeLog) text += `• ${c.what}: ${c.before} → ${c.after}\n`;
    const links = [...new Set(changeLog.flatMap((c) => c.links || []))];
    text += `\nCheck it:\n${links.join('\n')}\n`;
  } else {
    text += `\nNo changes were made.\n`;
  }
  text += `\n👉 Approve: move this task to DONE.\n👉 Revise: reply with a comment and I'll redo it.`;
  return text;
}

/* ---------------- Main poll loop ---------------- */

const busy = new Set();

async function handleNewTask(task) {
  console.log(`\n📥 New task: ${task.name}`);
  await setStatus(task.id, STATUS.working);
  const instruction = `Task: ${task.name}\n${task.text_content ? 'Details: ' + task.text_content : ''}`;
  const summary = await runAgent(instruction);
  await addComment(task.id, buildReport(summary));
  await setStatus(task.id, STATUS.review);
  console.log(`✅ Sent for review: ${task.name}`);
}

async function handleReview(task) {
  const comments = (await getComments(task.id)).sort((a, b) => Number(b.date) - Number(a.date));
  const latest = comments[0];
  if (!latest) return;
  if (handledComments.has(String(latest.id)) || (latest.comment_text || '').trim().startsWith(AGENT_TAG)) return; // nothing new from a human
  handledComments.add(String(latest.id));

  const lastAgent = comments.find((c) => (c.comment_text || '').trim().startsWith(AGENT_TAG));
  console.log(`\n💬 Feedback on "${task.name}": ${latest.comment_text}`);
  await setStatus(task.id, STATUS.working);
  const instruction =
    `Original task: ${task.name}\n${task.text_content ? 'Details: ' + task.text_content + '\n' : ''}` +
    `Your previous work:\n${lastAgent ? lastAgent.comment_text : '(none)'}\n\n` +
    `The reviewer replied with this feedback. Apply it:\n${latest.comment_text}`;
  const summary = await runAgent(instruction);
  await addComment(task.id, buildReport(summary));
  await setStatus(task.id, STATUS.review);
  console.log(`✅ Revised and sent for review: ${task.name}`);
}

async function poll() {
  try {
    const tasks = await getTasks();
    for (const task of tasks) {
      if (busy.has(task.id)) continue;
      const s = task.status.status.toLowerCase();
      if (s !== STATUS.todo && s !== STATUS.review) continue;
      busy.add(task.id);
      try {
        if (s === STATUS.todo) await handleNewTask(task);
        else await handleReview(task);
      } catch (e) {
        console.error(`❌ Error on "${task.name}":`, e.message);
        await addComment(task.id, `${AGENT_TAG}\n\nI hit an error: ${e.message}`).catch(() => {});
      } finally {
        busy.delete(task.id);
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
  setTimeout(poll, POLL_MS);
}

console.log(`🤖 Agent running. Watching ClickUp list ${CLICKUP_LIST_ID} every ${POLL_MS / 1000}s...`);
poll();