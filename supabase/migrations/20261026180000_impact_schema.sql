-- Impact Data schema.
-- Paste this whole file into the Supabase SQL editor and run it once on an empty project.
-- It enables pgvector, creates the tables, turns on row level security with no public
-- policies, and adds the two search functions the Next.js server calls.

-- Supabase keeps pgvector in the extensions schema. The search path below lets the
-- rest of this file use the plain vector(1536) type, which is what OpenAI
-- text-embedding-3-small produces.
create extension if not exists vector with schema extensions;

set search_path = public, extensions;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sector text,
  geography text,
  website text,
  created_at timestamptz not null default now()
);

create table public.indicators (
  id uuid primary key default gen_random_uuid(),
  -- Deleting an organization is refused while it still has indicators, so a
  -- click in the table editor cannot wipe its measures by accident.
  organization_id uuid not null references public.organizations (id),
  name text not null,
  definition text not null,
  sector text not null,
  outcome text,
  population text,
  unit text,
  timeframe text,
  geography text,
  embedding vector(1536),
  source text not null default 'submission' check (source in ('submission', 'import')),
  created_at timestamptz not null default now()
);

-- The five components are stored twice on purpose. The columns on indicators let
-- a search return them in one row. These rows store the same values one facet at
-- a time, so a single facet can be read or replaced without rewriting the indicator.
-- The app writes both, and it skips a row when that facet is empty.
create table public.indicator_components (
  id uuid primary key default gen_random_uuid(),
  indicator_id uuid not null references public.indicators (id) on delete cascade,
  kind text not null check (kind in ('outcome', 'population', 'unit', 'timeframe', 'geography')),
  value text not null,
  unique (indicator_id, kind)
);

create table public.clusters (
  id uuid primary key default gen_random_uuid(),
  sector text not null,
  label text,
  description text,
  comparability_grade text check (comparability_grade in ('high', 'medium', 'low')),
  comparability_notes text,
  centroid vector(1536),
  created_at timestamptz not null default now()
);

create table public.cluster_members (
  cluster_id uuid not null references public.clusters (id) on delete cascade,
  indicator_id uuid not null references public.indicators (id) on delete cascade,
  similarity real not null,
  primary key (cluster_id, indicator_id)
);

-- Postgres does not index foreign keys on its own. These indexes keep lookups
-- and cascading deletes from scanning the whole table. The unique constraint on
-- indicator_components already indexes indicator_id.
create index indicators_organization_id_idx on public.indicators (organization_id);
create index indicators_sector_idx on public.indicators (sector);
create index indicators_geography_idx on public.indicators (geography);
create index clusters_sector_idx on public.clusters (sector);
create index cluster_members_indicator_id_idx on public.cluster_members (indicator_id);

-- HNSW indexes answer "what is near this embedding?" with cosine distance, the
-- same <=> operator the functions below use. Supabase runs this file as one
-- transaction. A normal create index is allowed there. create index concurrently
-- is not, so it is not used. The tables are empty on the first run, so the build
-- does not block writers.
create index indicators_embedding_hnsw
  on public.indicators
  using hnsw (embedding vector_cosine_ops);

create index clusters_centroid_hnsw
  on public.clusters
  using hnsw (centroid vector_cosine_ops);

-- Row level security is on, and there are no policies for the anon or
-- authenticated roles. The public API therefore cannot read these tables.
-- The Next.js server uses the service role key, which bypasses row level
-- security. That key stays on the server.
alter table public.organizations enable row level security;
alter table public.indicators enable row level security;
alter table public.indicator_components enable row level security;
alter table public.clusters enable row level security;
alter table public.cluster_members enable row level security;

-- Cosine similarity is 1 minus cosine distance. 1 is a perfect match.
-- min_similarity is the cutoff the app passes in. Search passes a very low
-- cutoff and then limits the rows. Clustering applies its own threshold in
-- the app, after it has seen the nearest cluster.
create or replace function public.match_indicators(
  query_embedding vector(1536),
  match_count int,
  min_similarity float,
  filter_sector text default null,
  filter_geography text default null
)
returns table (
  id uuid,
  name text,
  definition text,
  sector text,
  geography text,
  organization text,
  outcome text,
  population text,
  unit text,
  timeframe text,
  similarity float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    i.id,
    i.name,
    i.definition,
    i.sector,
    i.geography,
    o.name as organization,
    i.outcome,
    i.population,
    i.unit,
    i.timeframe,
    (1 - (i.embedding <=> query_embedding))::float as similarity
  from public.indicators i
  join public.organizations o on o.id = i.organization_id
  where i.embedding is not null
    and (filter_sector is null or i.sector = filter_sector)
    and (filter_geography is null or i.geography = filter_geography)
    and (1 - (i.embedding <=> query_embedding)) >= min_similarity
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_clusters(
  query_embedding vector(1536),
  filter_sector text,
  match_count int
)
returns table (
  id uuid,
  label text,
  sector text,
  similarity float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.label,
    c.sector,
    (1 - (c.centroid <=> query_embedding))::float as similarity
  from public.clusters c
  where c.sector = filter_sector
    and c.centroid is not null
  order by c.centroid <=> query_embedding
  limit match_count;
$$;

-- These functions run as the caller, so row level security still applies.
-- The service role bypasses it. The public API roles are not allowed to call
-- the functions at all. The loop avoids a mistake in the argument types: Postgres
-- stores vector(1536) on a function as plain vector.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('match_indicators', 'match_clusters')
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
