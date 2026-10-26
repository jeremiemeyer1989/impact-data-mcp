// OpenAI embeddings for indicator text.
// Search, submission, and import all use text-embedding-3-small so every vector
// has 1536 dimensions and can be compared with the others. Do not mix in another model.

import OpenAI from "openai";
import type { IndicatorComponents } from "./components";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

export function embeddingSourceText(input: {
  name: string;
  definition: string;
  components: IndicatorComponents;
}): string {
  return [
    `Name: ${input.name}`,
    `Definition: ${input.definition}`,
    `Outcome: ${input.components.outcome}`,
    `Population: ${input.components.population}`,
    `Unit: ${input.components.unit}`,
    `Timeframe: ${input.components.timeframe}`,
    `Geography: ${input.components.geography}`,
  ].join("\n");
}

export async function embedText(text: string): Promise<number[]> {
  if (typeof window !== "undefined") {
    throw new Error("Embeddings can only be created on the server.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error("OpenAI returned an embedding that is not 1536 numbers long.");
  }
  return embedding;
}
