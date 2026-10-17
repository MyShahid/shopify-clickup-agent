# ClickUp → AI Agent → Shopify

A proof of concept for an agentic Shopify workflow driven from ClickUp:

```
ClickUp task (TO DO)
   → agent picks it up (AGENT WORKING)
   → Claude plans the work and calls Shopify tools
   → result posted back to the task: summary, before → after, preview/admin links (NEEDS REVIEW)
   → human approves (DONE)  or  comments feedback → agent revises → NEEDS REVIEW again
```

## What it can do

**Admin tasks** (Shopify Admin GraphQL API)
- Find products and variants
- Change prices
- Update product titles and descriptions

**Theme tasks** (Shopify CLI)
- Search, read and edit theme files (Liquid, JSON templates, sections, CSS)
- Create new theme files, such as a new section
- Works **only** on an unpublished theme named `Agent Preview`, enforced in code. The live theme is never touched.
- The reviewer checks the preview link, then publishes the theme to go live

## Safety
- The agent never closes its own task. Approval is always human.
- Theme writes are blocked in code for the live theme and for any theme not named "Agent Preview".
- Every change is logged as before → after in the ClickUp comment.
- Ambiguous tasks → no changes; the agent asks for clarification instead.

## Setup
1. Node 18+, plus [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm i -g @shopify/cli`), logged in to the store
2. A Shopify Dev Dashboard app installed on the store with `read_products, write_products, read_themes, write_themes`
3. A ClickUp list with statuses: `TO DO`, `AGENT WORKING`, `NEEDS REVIEW`, `DONE`
4. Duplicate the live theme and name the copy `Agent Preview`
5. `npm install`, then create a `.env` file:

```
SHOPIFY_STORE=your-store
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
CLICKUP_TOKEN=pk_...
CLICKUP_LIST_ID=...
ANTHROPIC_API_KEY=sk-ant-...
```

6. `node test.js` to check connections, then `node agent.js` to start the agent

## Next steps (production)
- ClickUp webhooks instead of polling; run as a small server or serverless function (Netlify/Vercel)
- One "Agent Preview" theme per client store, with git-backed theme history
- The same loop for headless CMSs (Storyblok, Sanity, Craft CMS) through their content APIs, with Netlify/Vercel preview deploys for review