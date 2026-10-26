// Imports indicators from a CSV file.
// Claude is not called. Component columns in the file are stored as given.
// Embeddings are added only when OPENAI_API_KEY is set. Without that key the
// rows are still saved, and the script says that embeddings were skipped.

import { loadEnvFiles } from "./load-env";
import { readFileSync } from "node:fs";
import { componentsFromValues } from "../lib/components";
import { importIndicator, storeEmbedding } from "../lib/indicators";
import { parseCsv } from "./csv";

loadEnvFiles();

const REQUIRED = ["organization_name", "sector", "indicator_name", "definition"] as const;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/import-indicators.ts <path-to.csv>");
    process.exit(1);
  }

  const { headers, records } = parseCsv(readFileSync(path, "utf8"));
  for (const column of REQUIRED) {
    if (!headers.includes(column)) {
      throw new Error(`The CSV is missing a ${column} column.`);
    }
  }
  if (records.length === 0) throw new Error("The CSV has no indicator rows.");

  records.forEach((record, index) => {
    for (const column of REQUIRED) {
      if (!record[column]?.trim()) {
        throw new Error(`Data row ${index + 1} is missing ${column}.`);
      }
    }
  });

  const saved: {
    id: string;
    name: string;
    definition: string;
    components: ReturnType<typeof componentsFromValues>;
  }[] = [];

  for (const [index, record] of records.entries()) {
    try {
      const components = componentsFromValues({
        outcome: record.outcome,
        population: record.population,
        unit: record.unit,
        timeframe: record.timeframe,
        geography: record.geography,
      });
      saved.push(
        await importIndicator({
          organizationName: record.organization_name,
          sector: record.sector,
          name: record.indicator_name,
          definition: record.definition,
          geography: record.geography,
          website: record.website,
          components,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "The row could not be saved.";
      throw new Error(`Data row ${index + 1} (${record.indicator_name}) was not saved. ${message}`);
    }
  }

  console.log(`Inserted ${saved.length} indicators.`);

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log("Embeddings were skipped because OPENAI_API_KEY is not set.");
    console.log("Search and clustering will not see these rows until they have embeddings.");
    console.log("This import does not call Claude.");
    console.log("Running the import again adds the rows again. Delete these rows first if you want to start over once the key is set.");
    return;
  }

  for (const [index, indicator] of saved.entries()) {
    try {
      await storeEmbedding(indicator.id, indicator);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The embedding failed.";
      throw new Error(
        `Embedded ${index} indicators, then stopped on "${indicator.name}". ${message}`,
      );
    }
  }

  console.log(`Embedded ${saved.length} indicators.`);
  console.log("This import does not call Claude. Run the clustering script when you want groups.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Import failed.");
  process.exit(1);
});
