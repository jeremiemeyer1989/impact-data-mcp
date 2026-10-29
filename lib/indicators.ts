// Reading and writing indicators.
// Submission extracts the five components with Claude, stores them, embeds the
// text, and may join an existing cluster. Import and search use the same shape.

import {
  type ComparabilityJudgment,
  extractComponents,
  judgeComparability,
} from "./anthropic";
import {
  COMPONENT_KINDS,
  type ComponentKind,
  type IndicatorComponents,
  componentColumns,
  componentsFromValues,
  nonEmptyComponentRows,
} from "./components";
import { embeddingSourceText, embedText } from "./embeddings";
import { getSupabase } from "./supabase";
import { parseVector, readClusterThreshold } from "./vectors";

type IndicatorMatch = {
  id: string;
  name: string;
  definition: string;
  sector: string;
  geography: string | null;
  organization: string;
  outcome: string | null;
  population: string | null;
  unit: string | null;
  timeframe: string | null;
  similarity: number;
};

type StoredIndicator = {
  id: string;
  organization_id: string;
  name: string;
  definition: string;
  sector: string;
  geography: string | null;
  outcome: string | null;
  population: string | null;
  unit: string | null;
  timeframe: string | null;
  embedding: unknown;
};

const COMPONENT_LABELS: Record<ComponentKind, string> = {
  outcome: "Outcome",
  population: "Population",
  unit: "Unit",
  timeframe: "Timeframe",
  geography: "Geography",
};

function databaseError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The database returned an indicator without a ${label}.`);
  }
  return value;
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("The database returned a similarity that was not a number.");
  }
  return number;
}

function organizationName(value: unknown): string {
  const record = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  return typeof record?.name === "string" ? record.name : "";
}

function readMatch(value: unknown): IndicatorMatch {
  const row = asRecord(value);
  if (!row) throw new Error("The database returned a search row that could not be read.");
  return {
    id: requiredText(row.id, "id"),
    name: requiredText(row.name, "name"),
    definition: requiredText(row.definition, "definition"),
    sector: requiredText(row.sector, "sector"),
    geography: textOrNull(row.geography),
    organization: typeof row.organization === "string" ? row.organization : "",
    outcome: textOrNull(row.outcome),
    population: textOrNull(row.population),
    unit: textOrNull(row.unit),
    timeframe: textOrNull(row.timeframe),
    similarity: finiteNumber(row.similarity),
  };
}

function readStored(value: unknown): StoredIndicator {
  const row = asRecord(value);
  if (!row) throw new Error("The database returned an indicator that could not be read.");
  return {
    id: requiredText(row.id, "id"),
    organization_id: requiredText(row.organization_id, "organization"),
    name: requiredText(row.name, "name"),
    definition: requiredText(row.definition, "definition"),
    sector: requiredText(row.sector, "sector"),
    geography: textOrNull(row.geography),
    outcome: textOrNull(row.outcome),
    population: textOrNull(row.population),
    unit: textOrNull(row.unit),
    timeframe: textOrNull(row.timeframe),
    embedding: row.embedding,
  };
}

function publicIndicator(match: IndicatorMatch) {
  return {
    id: match.id,
    name: match.name,
    definition: match.definition,
    sector: match.sector,
    geography: match.geography,
    organization: match.organization,
    outcome: match.outcome,
    population: match.population,
    unit: match.unit,
    timeframe: match.timeframe,
    similarity: match.similarity,
  };
}

function provided(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function upsertOrganization(input: {
  name: string;
  sector?: string;
  geography?: string;
  website?: string;
}): Promise<string> {
  const supabase = getSupabase();
  const name = input.name.trim();
  const patch: { sector?: string; geography?: string; website?: string } = {};
  const sector = provided(input.sector);
  const geography = provided(input.geography);
  const website = provided(input.website);
  if (sector) patch.sector = sector;
  if (geography) patch.geography = geography;
  if (website) patch.website = website;

  const existingResult = await supabase
    .from("organizations")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  databaseError(existingResult.error);
  const existing = asRecord(existingResult.data);

  if (existing?.id && typeof existing.id === "string") {
    if (Object.keys(patch).length > 0) {
      const update = await supabase.from("organizations").update(patch).eq("id", existing.id);
      databaseError(update.error);
    }
    return existing.id;
  }

  const inserted = await supabase
    .from("organizations")
    .insert({ name, ...patch })
    .select("id")
    .single();

  // Two submissions with the same organization name can arrive together.
  // The name is unique, so the second insert loses and we use the row that won.
  if (inserted.error?.code === "23505") {
    const raced = await supabase.from("organizations").select("id").eq("name", name).single();
    databaseError(raced.error);
    const racedRow = asRecord(raced.data);
    if (!racedRow || typeof racedRow.id !== "string") {
      throw new Error("The organization name already exists, but the row could not be read.");
    }
    if (Object.keys(patch).length > 0) {
      const update = await supabase.from("organizations").update(patch).eq("id", racedRow.id);
      databaseError(update.error);
    }
    return racedRow.id;
  }

  databaseError(inserted.error);
  const created = asRecord(inserted.data);
  if (!created || typeof created.id !== "string") {
    throw new Error("The organization was saved, but its id could not be read.");
  }
  return created.id;
}

async function insertIndicator(input: {
  organizationId: string;
  name: string;
  definition: string;
  sector: string;
  components: IndicatorComponents;
  source: "submission" | "import";
  embedding?: number[];
}): Promise<string> {
  const supabase = getSupabase();
  const inserted = await supabase
    .from("indicators")
    .insert({
      organization_id: input.organizationId,
      name: input.name.trim(),
      definition: input.definition.trim(),
      sector: input.sector.trim(),
      source: input.source,
      ...componentColumns(input.components),
      ...(input.embedding ? { embedding: input.embedding } : {}),
    })
    .select("id")
    .single();
  databaseError(inserted.error);
  const row = asRecord(inserted.data);
  if (!row || typeof row.id !== "string") {
    throw new Error("The indicator was saved, but its id could not be read.");
  }

  // Columns were written above. Rows below store each non-empty component on its
  // own, so one facet can be read or replaced without rewriting the indicator.
  const componentRows = nonEmptyComponentRows(row.id, input.components);
  if (componentRows.length === 0) return row.id;

  const components = await supabase.from("indicator_components").insert(componentRows);
  if (components.error) {
    await supabase.from("indicators").delete().eq("id", row.id);
    throw new Error(components.error.message);
  }
  return row.id;
}

export async function importIndicator(input: {
  organizationName: string;
  sector: string;
  name: string;
  definition: string;
  geography?: string;
  website?: string;
  components: IndicatorComponents;
}): Promise<{ id: string; name: string; definition: string; components: IndicatorComponents }> {
  const organizationId = await upsertOrganization({
    name: input.organizationName,
    sector: input.sector,
    geography: input.geography,
    website: input.website,
  });
  const components = componentsFromValues({
    ...input.components,
    geography: provided(input.geography) || input.components.geography,
  });
  const id = await insertIndicator({
    organizationId,
    name: input.name,
    definition: input.definition,
    sector: input.sector,
    components,
    source: "import",
  });
  return { id, name: input.name.trim(), definition: input.definition.trim(), components };
}

export async function storeEmbedding(
  indicatorId: string,
  input: { name: string; definition: string; components: IndicatorComponents },
): Promise<void> {
  const embedding = await embedText(embeddingSourceText(input));
  const updated = await getSupabase()
    .from("indicators")
    .update({ embedding })
    .eq("id", indicatorId);
  databaseError(updated.error);
}

async function matchIndicators(input: {
  embedding: number[];
  limit: number;
  sector?: string;
  geography?: string;
}): Promise<IndicatorMatch[]> {
  // Search wants the nearest rows, so the cutoff here is as low as cosine
  // similarity goes. The cluster threshold is a separate rule, used only when
  // deciding whether an indicator may join a cluster.
  const result = await getSupabase().rpc("match_indicators", {
    query_embedding: input.embedding,
    match_count: input.limit,
    min_similarity: -1,
    filter_sector: input.sector ?? null,
    filter_geography: input.geography ?? null,
  });
  databaseError(result.error);
  return (Array.isArray(result.data) ? result.data : []).map(readMatch);
}

async function matchClusters(
  embedding: number[],
  sector: string,
  limit: number,
): Promise<{ id: string; label: string | null; sector: string; similarity: number }[]> {
  const result = await getSupabase().rpc("match_clusters", {
    query_embedding: embedding,
    filter_sector: sector,
    match_count: limit,
  });
  databaseError(result.error);
  return (Array.isArray(result.data) ? result.data : []).map((item) => {
    const row = asRecord(item);
    if (!row) throw new Error("The database returned a cluster that could not be read.");
    return {
      id: requiredText(row.id, "id"),
      label: textOrNull(row.label),
      sector: requiredText(row.sector, "sector"),
      similarity: finiteNumber(row.similarity),
    };
  });
}

export async function searchIndicators(input: {
  query: string;
  sector?: string;
  geography?: string;
  limit: number;
}) {
  const embedding = await embedText(input.query);
  const matches = await matchIndicators({
    embedding,
    limit: input.limit,
    sector: input.sector,
    geography: input.geography,
  });
  return matches.map(publicIndicator);
}

async function loadStored(id: string): Promise<StoredIndicator> {
  const result = await getSupabase()
    .from("indicators")
    .select(
      "id, organization_id, name, definition, sector, geography, outcome, population, unit, timeframe, embedding",
    )
    .eq("id", id)
    .maybeSingle();
  databaseError(result.error);
  if (!result.data) throw new Error(`No indicator exists with id ${id}.`);
  return readStored(result.data);
}

async function loadStoredComponents(indicator: StoredIndicator): Promise<IndicatorComponents> {
  const fromColumns = componentsFromValues(indicator);
  const result = await getSupabase()
    .from("indicator_components")
    .select("kind, value")
    .eq("indicator_id", indicator.id);
  databaseError(result.error);
  const merged = { ...fromColumns };
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const row = asRecord(item);
    const kind = row?.kind;
    if (typeof kind === "string" && COMPONENT_KINDS.includes(kind as ComponentKind)) {
      merged[kind as ComponentKind] = typeof row?.value === "string" ? row.value.trim() : "";
    }
  }
  return merged;
}

function formatComparison(input: {
  leftName?: string;
  rightName?: string;
  left: IndicatorComponents;
  right: IndicatorComponents;
  judgment: ComparabilityJudgment;
}): string {
  const leftName = input.leftName?.trim() || "Definition A";
  const rightName = input.rightName?.trim() || "Definition B";
  const lines = [`${leftName} compared with ${rightName}`, ""];

  for (const [title, components] of [
    [leftName, input.left],
    [rightName, input.right],
  ] as const) {
    lines.push(`Components for ${title}`);
    for (const kind of COMPONENT_KINDS) {
      lines.push(`- ${COMPONENT_LABELS[kind]}: ${components[kind] || "not stated"}`);
    }
    lines.push("");
  }

  lines.push("Comparability");
  for (const kind of COMPONENT_KINDS) {
    const part = input.judgment.components[kind];
    const stance = part.aligns ? "aligns" : "does not align";
    lines.push(`${COMPONENT_LABELS[kind]}: ${stance}. ${part.reason.trim() || "No reason given."}`);
  }
  if (input.judgment.summary.trim()) {
    lines.push("");
    lines.push(input.judgment.summary.trim());
  }
  lines.push("");
  lines.push(`Overall grade: ${input.judgment.grade}`);
  return lines.join("\n");
}

export async function compareDefinitions(input: {
  indicatorAId?: string;
  indicatorBId?: string;
  definitionA?: string;
  definitionB?: string;
  nameA?: string;
  nameB?: string;
}): Promise<string> {
  let leftName = input.nameA;
  let rightName = input.nameB;
  let leftDefinition: string;
  let rightDefinition: string;
  let leftComponents: IndicatorComponents;
  let rightComponents: IndicatorComponents;

  if (input.indicatorAId && input.indicatorBId) {
    const left = await loadStored(input.indicatorAId);
    const right = await loadStored(input.indicatorBId);
    leftDefinition = left.definition;
    rightDefinition = right.definition;
    leftComponents = await loadStoredComponents(left);
    rightComponents = await loadStoredComponents(right);
    leftName = input.nameA || left.name;
    rightName = input.nameB || right.name;
  } else if (input.definitionA && input.definitionB) {
    // Raw definitions are judged in memory. They are not written to the database.
    leftDefinition = input.definitionA;
    rightDefinition = input.definitionB;
    leftComponents = await extractComponents(input.definitionA);
    rightComponents = await extractComponents(input.definitionB);
  } else {
    throw new Error("Provide indicator_a_id and indicator_b_id, or definition_a and definition_b.");
  }

  const judgment = await judgeComparability({
    kind: "compare",
    left: { name: leftName, definition: leftDefinition, components: leftComponents },
    right: { name: rightName, definition: rightDefinition, components: rightComponents },
  });

  return formatComparison({
    leftName,
    rightName,
    left: leftComponents,
    right: rightComponents,
    judgment,
  });
}

export async function submitIndicator(input: {
  organizationName: string;
  sector: string;
  name: string;
  definition: string;
  geography?: string;
  website?: string;
}) {
  const organizationId = await upsertOrganization({
    name: input.organizationName,
    sector: input.sector,
    geography: input.geography,
    website: input.website,
  });
  const extracted = await extractComponents(input.definition);
  const callerGeography = provided(input.geography);
  const components = componentsFromValues({
    ...extracted,
    geography: callerGeography || extracted.geography,
  });
  const embedding = await embedText(
    embeddingSourceText({
      name: input.name,
      definition: input.definition,
      components,
    }),
  );
  const indicatorId = await insertIndicator({
    organizationId,
    name: input.name,
    definition: input.definition,
    sector: input.sector,
    components,
    source: "submission",
    embedding,
  });

  const nearest = await matchClusters(embedding, input.sector.trim(), 1);
  const best = nearest[0];
  const threshold = readClusterThreshold();
  if (!best || best.similarity < threshold) {
    return {
      indicator_id: indicatorId,
      components,
      unclustered: true as const,
    };
  }

  const membership = await getSupabase().from("cluster_members").insert({
    cluster_id: best.id,
    indicator_id: indicatorId,
    similarity: best.similarity,
  });
  if (membership.error) {
    throw new Error(
      `The indicator ${indicatorId} was saved, but it could not be added to the cluster. ${membership.error.message}`,
    );
  }

  return {
    indicator_id: indicatorId,
    components,
    cluster: {
      id: best.id,
      label: best.label,
      similarity: best.similarity,
    },
  };
}

async function loadIndicatorsByIds(ids: string[]): Promise<Map<string, StoredIndicator & { organization: string }>> {
  const found = new Map<string, StoredIndicator & { organization: string }>();
  if (ids.length === 0) return found;
  const result = await getSupabase()
    .from("indicators")
    .select(
      "id, organization_id, name, definition, sector, geography, outcome, population, unit, timeframe, embedding, organizations(name)",
    )
    .in("id", ids);
  databaseError(result.error);
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const row = asRecord(item);
    if (!row) continue;
    const stored = readStored(row);
    found.set(stored.id, { ...stored, organization: organizationName(row.organizations) });
  }
  return found;
}

export async function findPeers(input: {
  indicatorId?: string;
  organizationId?: string;
  limit: number;
}) {
  if (input.indicatorId) return findIndicatorPeers(input.indicatorId, input.limit);
  if (input.organizationId) return findOrganizationPeers(input.organizationId, input.limit);
  throw new Error("Provide either indicator_id or organization_id.");
}

async function findIndicatorPeers(indicatorId: string, limit: number) {
  const indicator = await loadStored(indicatorId);
  const memberships = await getSupabase()
    .from("cluster_members")
    .select("cluster_id, indicator_id, similarity")
    .eq("indicator_id", indicatorId);
  databaseError(memberships.error);
  const ownMemberships = (Array.isArray(memberships.data) ? memberships.data : [])
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);

  if (ownMemberships.length === 0) {
    if (indicator.embedding == null) {
      return {
        indicator_id: indicatorId,
        matched_by: "similar_indicators" as const,
        peers: [],
        note: "This indicator is not in a cluster and has no embedding to search with.",
      };
    }
    const matches = await matchIndicators({
      embedding: parseVector(indicator.embedding),
      sector: indicator.sector,
      limit: limit + 1,
    });
    return {
      indicator_id: indicatorId,
      matched_by: "similar_indicators" as const,
      peers: matches.filter((match) => match.id !== indicatorId).slice(0, limit).map(publicIndicator),
    };
  }

  const clusterIds = ownMemberships
    .map((row) => row.cluster_id)
    .filter((id): id is string => typeof id === "string");
  const memberResult = await getSupabase()
    .from("cluster_members")
    .select("cluster_id, indicator_id, similarity")
    .in("cluster_id", clusterIds);
  databaseError(memberResult.error);
  const memberRows = (Array.isArray(memberResult.data) ? memberResult.data : [])
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);

  const clusterResult = await getSupabase()
    .from("clusters")
    .select("id, label")
    .in("id", clusterIds);
  databaseError(clusterResult.error);
  const labels = new Map<string, string | null>();
  for (const item of Array.isArray(clusterResult.data) ? clusterResult.data : []) {
    const row = asRecord(item);
    if (row && typeof row.id === "string") labels.set(row.id, textOrNull(row.label));
  }

  const peerIds = [
    ...new Set(
      memberRows
        .map((row) => row.indicator_id)
        .filter((id): id is string => typeof id === "string" && id !== indicatorId),
    ),
  ];
  const indicators = await loadIndicatorsByIds(peerIds);
  const best = new Map<
    string,
    IndicatorMatch & { cluster_id: string; cluster_label: string | null }
  >();

  for (const row of memberRows) {
    if (typeof row.indicator_id !== "string" || row.indicator_id === indicatorId) continue;
    if (typeof row.cluster_id !== "string") continue;
    const stored = indicators.get(row.indicator_id);
    if (!stored) continue;
    const similarity = finiteNumber(row.similarity);
    const current = best.get(stored.id);
    if (current && current.similarity >= similarity) continue;
    best.set(stored.id, {
      id: stored.id,
      name: stored.name,
      definition: stored.definition,
      sector: stored.sector,
      geography: stored.geography,
      organization: stored.organization,
      outcome: stored.outcome,
      population: stored.population,
      unit: stored.unit,
      timeframe: stored.timeframe,
      similarity,
      cluster_id: row.cluster_id,
      cluster_label: labels.get(row.cluster_id) ?? null,
    });
  }

  const peers = [...best.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)
    .map((peer) => ({
      ...publicIndicator(peer),
      cluster_id: peer.cluster_id,
      cluster_label: peer.cluster_label,
    }));

  return {
    indicator_id: indicatorId,
    matched_by: "cluster" as const,
    peers,
  };
}

async function findOrganizationPeers(organizationId: string, limit: number) {
  const organization = await getSupabase()
    .from("organizations")
    .select("id, name")
    .eq("id", organizationId)
    .maybeSingle();
  databaseError(organization.error);
  const organizationRow = asRecord(organization.data);
  if (!organizationRow || typeof organizationRow.name !== "string") {
    throw new Error(`No organization exists with id ${organizationId}.`);
  }

  const indicatorResult = await getSupabase()
    .from("indicators")
    .select(
      "id, organization_id, name, definition, sector, geography, outcome, population, unit, timeframe, embedding",
    )
    .eq("organization_id", organizationId);
  databaseError(indicatorResult.error);
  const indicators = (Array.isArray(indicatorResult.data) ? indicatorResult.data : []).map(readStored);
  if (indicators.length === 0) {
    return {
      organization_id: organizationId,
      organization: organizationRow.name,
      matched_by: "shared_clusters" as const,
      peers: [],
      note: "This organization has no indicators yet.",
    };
  }

  const memberships = await getSupabase()
    .from("cluster_members")
    .select("cluster_id, indicator_id")
    .in(
      "indicator_id",
      indicators.map((indicator) => indicator.id),
    );
  databaseError(memberships.error);
  const ownMemberships = (Array.isArray(memberships.data) ? memberships.data : [])
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);

  if (ownMemberships.length === 0) {
    return {
      organization_id: organizationId,
      organization: organizationRow.name,
      ...(await nearestIndicatorsFromOtherOrganizations(indicators, organizationRow.name, limit)),
    };
  }

  const clusterIds = [
    ...new Set(
      ownMemberships
        .map((row) => row.cluster_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const memberResult = await getSupabase()
    .from("cluster_members")
    .select("cluster_id, indicator_id")
    .in("cluster_id", clusterIds);
  databaseError(memberResult.error);
  const memberRows = (Array.isArray(memberResult.data) ? memberResult.data : [])
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
  const memberIndicators = await loadIndicatorsByIds(
    memberRows
      .map((row) => row.indicator_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const clusterResult = await getSupabase().from("clusters").select("id, label").in("id", clusterIds);
  databaseError(clusterResult.error);
  const labels = new Map<string, string | null>();
  for (const item of Array.isArray(clusterResult.data) ? clusterResult.data : []) {
    const row = asRecord(item);
    if (row && typeof row.id === "string") labels.set(row.id, textOrNull(row.label));
  }

  const counts = new Map<string, { organizationId: string; organization: string; clusterId: string; count: number }>();
  for (const row of memberRows) {
    if (typeof row.cluster_id !== "string" || typeof row.indicator_id !== "string") continue;
    const stored = memberIndicators.get(row.indicator_id);
    if (!stored || stored.organization_id === organizationId) continue;
    const key = `${stored.organization_id}:${row.cluster_id}`;
    const current = counts.get(key) ?? {
      organizationId: stored.organization_id,
      organization: stored.organization,
      clusterId: row.cluster_id,
      count: 0,
    };
    current.count += 1;
    counts.set(key, current);
  }

  const sourceCounts = new Map<string, number>();
  for (const row of ownMemberships) {
    if (typeof row.cluster_id !== "string") continue;
    sourceCounts.set(row.cluster_id, (sourceCounts.get(row.cluster_id) ?? 0) + 1);
  }

  const peers = [...counts.values()]
    .map((peer) => ({
      organization_id: peer.organizationId,
      organization: peer.organization,
      cluster_id: peer.clusterId,
      cluster_label: labels.get(peer.clusterId) ?? null,
      overlap_count: peer.count + (sourceCounts.get(peer.clusterId) ?? 0),
    }))
    .sort((left, right) => right.overlap_count - left.overlap_count || left.organization.localeCompare(right.organization))
    .slice(0, limit);

  return {
    organization_id: organizationId,
    organization: organizationRow.name,
    matched_by: "shared_clusters" as const,
    peers,
  };
}

async function nearestIndicatorsFromOtherOrganizations(
  indicators: StoredIndicator[],
  organizationName: string,
  limit: number,
) {
  const embedded = indicators.filter((indicator) => indicator.embedding != null);
  if (embedded.length === 0) {
    return {
      matched_by: "nearest_indicators" as const,
      peers: [],
      note: "This organization has no clustered indicators and no embeddings to search with.",
    };
  }

  const best = new Map<string, IndicatorMatch>();
  for (const indicator of embedded) {
    const matches = await matchIndicators({
      embedding: parseVector(indicator.embedding),
      sector: indicator.sector,
      limit: Math.min(limit + embedded.length, 100),
    });
    for (const match of matches) {
      if (match.organization === organizationName) continue;
      const current = best.get(match.id);
      if (!current || match.similarity > current.similarity) best.set(match.id, match);
    }
  }

  return {
    matched_by: "nearest_indicators" as const,
    peers: [...best.values()]
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit)
      .map(publicIndicator),
  };
}
