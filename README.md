# Impact Data MCP

Copyright 2026 Jérémie Meyer, licensed under Apache 2.0.

## What this server does

This server keeps a library of impact indicators. It stores each definition, breaks it into outcome, population, unit, timeframe, and geography, and uses those parts to judge whether two numbers can be compared. Similar indicators in the same sector can be grouped into a cluster.

An MCP client talks to the server at `/api/mcp`. The data lives in Supabase Postgres, with pgvector holding the embeddings that make the search work.

## The four tools

- **search_indicators** — finds stored indicators whose meaning is close to a question, with an optional sector or geography.
- **compare_definitions** — says whether two indicators line up on outcome, population, unit, timeframe, and geography, and gives a grade of high, medium, or low.
- **submit_indicator** — saves a new indicator for an organization, extracts those five parts, and attaches it to a nearby cluster when one is close enough.
- **find_peers** — lists other indicators in the same cluster, or other organizations that share a cluster.

## Local setup

Install Node.js 20 or newer. In this folder, run:

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` using the list below. Then start the server:

```bash
npm run dev
```

The home page is [http://localhost:3000](http://localhost:3000). The MCP endpoint is `http://localhost:3000/api/mcp`.

## Environment variables

Copy `.env.example` to `.env.local`. Do not commit `.env` or `.env.local`.

The service role key and `MCP_API_KEY` must never be committed, and they must never be placed in a variable whose name starts with `NEXT_PUBLIC_`. Next.js sends those variables to the browser.

- **SUPABASE_URL** — the project URL. In Supabase, open Project Settings, then API. It looks like `https://something.supabase.co`.
- **SUPABASE_SERVICE_ROLE_KEY** — the service role secret on that same API page. The server uses it to read and write the tables. It bypasses row level security, so it stays on the server only. Do not put it in the browser, in git, or in a `NEXT_PUBLIC_` variable.
- **OPENAI_API_KEY** — an API key from [platform.openai.com](https://platform.openai.com/api-keys). It creates the embeddings used for search and clustering. The model is `text-embedding-3-small`.
- **ANTHROPIC_API_KEY** — an API key from [console.anthropic.com](https://console.anthropic.com/). Claude reads definitions and writes cluster labels.
- **ANTHROPIC_MODEL** — optional. Leave it empty to use `claude-sonnet-5-5`, the current Claude Sonnet model. If you set it, use a real model id from Anthropic's model list.
- **MCP_API_KEY** — a long random string you choose. Clients send it as `Authorization: Bearer <this value>`. Requests without it, or with the wrong value, are rejected. Do not commit it or put it in a `NEXT_PUBLIC_` variable.
- **CLUSTER_SIMILARITY_THRESHOLD** — optional. Leave it empty to use `0.78`. Similarity runs from -1 to 1, where 1 means the texts point the same way. A new indicator joins a cluster only when it is at least this close to that cluster. A higher number means fewer, tighter groups.

On Vercel, set the same variables in the project settings. Do not prefix the service role key or `MCP_API_KEY` with `NEXT_PUBLIC_`.

## Database

The database is Supabase Postgres with the `vector` extension (pgvector). The migration enables it in the `extensions` schema, which is where Supabase expects it.

1. Open your Supabase project.
2. Go to the SQL editor.
3. Paste the whole file `supabase/migrations/20261026180000_impact_schema.sql`.
4. Run it once.

If the editor says the extension is missing, open Database, then Extensions, search for `vector`, enable it, and run the file again.

The file also turns on row level security and adds no policies for the public API roles, so the anon key cannot read the tables. The app uses the service role key instead.

## Sample data and clustering

The file `data/sample-indicators.csv` has eight fictional indicators in two sectors, education and clean energy. The organizations are made up.

Import them with:

```bash
npx tsx scripts/import-indicators.ts data/sample-indicators.csv
```

The import does not call Claude. It uses the component columns in the file. If `OPENAI_API_KEY` is missing, the rows are still saved and the script tells you that embeddings were skipped. Running the import again adds the rows again.

When the rows have embeddings, group them with:

```bash
npx tsx scripts/cluster-indicators.ts
```

That script needs `ANTHROPIC_API_KEY`. It rebuilds clusters only for sectors that have embeddings, asks Claude for a label and a comparability grade, and prints one line per cluster: sector, label, grade, and how many indicators are in it. Sectors with no embeddings are left as they are.

## Deploy on Vercel

1. In Vercel, create a project and import this GitHub repository.
2. The framework must be Next.js. `vercel.json` sets that. The build command is `npm run build`.
3. Leave Output Directory empty. Do not set it to `public`. Next.js does not write the site into a `public` folder, and Vercel will fail the deploy if it looks for one.
4. Add the same environment variables as in `.env.local`.
5. Deploy.

The endpoint is `https://<project>.vercel.app/api/mcp`.

In the MCP client, set the URL to that address and send the API key as a Bearer token:

```text
Authorization: Bearer <MCP_API_KEY>
```

A request without that header, or with the wrong key, gets a 401 response.
