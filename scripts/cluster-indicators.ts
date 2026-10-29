// Groups embedded indicators into clusters, one sector at a time.
// An indicator joins the first cluster in its sector whose centroid is close
// enough. Otherwise it starts a new cluster. Sectors with no embeddings are
// left alone. Previous clusters for a sector are replaced only after Claude
// has labeled the new groups, so a failed labeling run does not wipe them.

import { loadEnvFiles } from "./load-env";
import { judgeComparability } from "../lib/anthropic";
import { componentsFromValues } from "../lib/components";
import { getSupabase, selectAll } from "../lib/supabase";
import { cosineSimilarity, meanUnitVector, parseVector, readClusterThreshold } from "../lib/vectors";

loadEnvFiles();

type EmbeddedIndicator = {
  id: string;
  name: string;
  definition: string;
  sector: string;
  components: ReturnType<typeof componentsFromValues>;
  vector: number[];
};

type DraftCluster = {
  members: EmbeddedIndicator[];
  vectors: number[][];
  centroid: number[];
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error("ANTHROPIC_API_KEY is not set, so the clusters cannot be labeled. Nothing was changed.");
    process.exit(1);
  }

  const threshold = readClusterThreshold();
  const rows = await selectAll((from, to) =>
    getSupabase()
      .from("indicators")
      .select(
        "id, name, definition, sector, outcome, population, unit, timeframe, geography, embedding, created_at",
      )
      .not("embedding", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  const bySector = new Map<string, EmbeddedIndicator[]>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.definition !== "string") {
      throw new Error("An indicator row could not be read.");
    }
    if (typeof row.sector !== "string" || row.embedding == null) continue;
    const indicator: EmbeddedIndicator = {
      id: row.id,
      name: row.name,
      definition: row.definition,
      sector: row.sector,
      components: componentsFromValues({
        outcome: typeof row.outcome === "string" ? row.outcome : null,
        population: typeof row.population === "string" ? row.population : null,
        unit: typeof row.unit === "string" ? row.unit : null,
        timeframe: typeof row.timeframe === "string" ? row.timeframe : null,
        geography: typeof row.geography === "string" ? row.geography : null,
      }),
      vector: parseVector(row.embedding),
    };
    const list = bySector.get(indicator.sector) ?? [];
    list.push(indicator);
    bySector.set(indicator.sector, list);
  }

  if (bySector.size === 0) {
    console.log("No indicators have embeddings yet. Nothing was changed.");
    console.log("Import or submit indicators with OPENAI_API_KEY set, then run this script again.");
    return;
  }

  const sectors = [...bySector.keys()].sort((left, right) => left.localeCompare(right));
  for (const sector of sectors) {
    const indicators = bySector.get(sector) ?? [];
    const drafts = clusterSector(indicators, threshold);
    const labeled = [];
    for (const draft of drafts) {
      const judgment = await judgeComparability({
        kind: "cluster",
        sector,
        members: draft.members.map((member) => ({
          name: member.name,
          definition: member.definition,
          components: member.components,
        })),
      });
      const centroid = meanUnitVector(draft.vectors);
      labeled.push({
        judgment,
        centroid,
        members: draft.members.map((member) => ({
          id: member.id,
          similarity: cosineSimilarity(member.vector, centroid),
        })),
      });
    }

    try {
      await replaceSector(sector, labeled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The clusters could not be saved.";
      throw new Error(`Could not save clusters for ${sector}. Run the script again to rebuild them. ${message}`);
    }

    for (const cluster of labeled) {
      console.log(
        `${sector} — ${cluster.judgment.label} — ${cluster.judgment.comparability_grade} — ${cluster.members.length} indicators`,
      );
    }
  }
}

function clusterSector(indicators: EmbeddedIndicator[], threshold: number): DraftCluster[] {
  const clusters: DraftCluster[] = [];
  for (const indicator of indicators) {
    let placed = false;
    for (const cluster of clusters) {
      if (cosineSimilarity(indicator.vector, cluster.centroid) < threshold) continue;
      cluster.members.push(indicator);
      cluster.vectors.push(indicator.vector);
      // The new centroid is the mean of the member vectors, then L2-normalised.
      cluster.centroid = meanUnitVector(cluster.vectors);
      placed = true;
      break;
    }
    if (placed) continue;
    clusters.push({
      members: [indicator],
      vectors: [indicator.vector],
      centroid: meanUnitVector([indicator.vector]),
    });
  }
  return clusters;
}

async function replaceSector(
  sector: string,
  clusters: {
    judgment: {
      label: string;
      description: string;
      comparability_grade: "high" | "medium" | "low";
      comparability_notes: string;
    };
    centroid: number[];
    members: { id: string; similarity: number }[];
  }[],
): Promise<void> {
  const supabase = getSupabase();
  const deleted = await supabase.from("clusters").delete().eq("sector", sector);
  if (deleted.error) throw new Error(deleted.error.message);

  for (const cluster of clusters) {
    const inserted = await supabase
      .from("clusters")
      .insert({
        sector,
        label: cluster.judgment.label,
        description: cluster.judgment.description,
        comparability_grade: cluster.judgment.comparability_grade,
        comparability_notes: cluster.judgment.comparability_notes,
        centroid: cluster.centroid,
      })
      .select("id")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);
    const row = inserted.data as { id?: string } | null;
    if (!row?.id) throw new Error("A cluster was saved, but its id could not be read.");

    const members = await supabase.from("cluster_members").insert(
      cluster.members.map((member) => ({
        cluster_id: row.id,
        indicator_id: member.id,
        similarity: member.similarity,
      })),
    );
    if (members.error) throw new Error(members.error.message);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Clustering failed.");
  process.exit(1);
});
