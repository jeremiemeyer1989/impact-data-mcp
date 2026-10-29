// Claude calls for reading a definition and for judging whether indicators match.
// The model id comes from ANTHROPIC_MODEL. When that is empty, the app uses
// claude-sonnet-5-5, the current Claude Sonnet model on the Anthropic API.

import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import {
  COMPONENT_KINDS,
  type ComponentKind,
  type IndicatorComponents,
  emptyComponents,
} from "./components";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

const phrase = z.preprocess((value) => {
  if (value == null) return "";
  return String(value).trim();
}, z.string());

const gradeSchema = z.preprocess((value) => {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}, z.enum(["high", "medium", "low"]));

const alignsSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "align", "aligns", "aligned"].includes(normalized)) return true;
    if (["false", "no", "differ", "differs", "misaligned"].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const componentJudgmentSchema = z.object({
  aligns: alignsSchema,
  reason: phrase,
});

const comparabilitySchema = z.object({
  outcome: componentJudgmentSchema,
  population: componentJudgmentSchema,
  unit: componentJudgmentSchema,
  timeframe: componentJudgmentSchema,
  geography: componentJudgmentSchema,
  grade: gradeSchema,
  summary: phrase,
});

const clusterSchema = z.object({
  label: phrase,
  description: phrase,
  comparability_grade: gradeSchema,
  comparability_notes: phrase,
});

export type ComparabilityJudgment = {
  components: Record<ComponentKind, { aligns: boolean; reason: string }>;
  grade: "high" | "medium" | "low";
  summary: string;
};

export type ClusterJudgment = {
  label: string;
  description: string;
  comparability_grade: "high" | "medium" | "low";
  comparability_notes: string;
};

type CompareSide = {
  name?: string;
  definition: string;
  components: IndicatorComponents;
};

type CompareRequest = {
  kind: "compare";
  left: CompareSide;
  right: CompareSide;
};

type ClusterRequest = {
  kind: "cluster";
  sector: string;
  members: CompareSide[];
};

function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

function getClient(): Anthropic {
  if (typeof window !== "undefined") {
    throw new Error("Claude can only be called on the server.");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey });
}

function messageText(message: Message): string {
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude stopped before it finished the answer.");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Claude returned no text.");
  return text;
}

// Models sometimes wrap JSON in ```json fences, or add a sentence around it.
function parseModelJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("Claude did not return JSON.");
    }
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      throw new Error("Claude returned text that could not be read as JSON.");
    }
  }
}

async function complete(prompt: string, maxTokens: number): Promise<unknown> {
  const message = await getClient().messages.create({
    model: anthropicModel(),
    max_tokens: maxTokens,
    system: "Reply with one JSON object only. Do not use markdown fences.",
    messages: [{ role: "user", content: prompt }],
  });
  return parseModelJson(messageText(message));
}

function formatComponents(components: IndicatorComponents): string {
  return COMPONENT_KINDS.map((kind) => `${kind}: ${components[kind] || "(not stated)"}`).join("\n");
}

export async function extractComponents(definition: string): Promise<IndicatorComponents> {
  const parsed = await complete(
    [
      "Read this impact-indicator definition and extract five short phrases.",
      "Use an empty string when the definition does not state that part. Do not invent a number or a place.",
      "outcome: the change or condition being measured.",
      "population: who or what the number is about.",
      "unit: the unit of the number, such as a share, a count, or hours.",
      "timeframe: the period the number covers.",
      "geography: the place it applies to.",
      'Return JSON with keys "outcome", "population", "unit", "timeframe", and "geography".',
      "",
      definition,
    ].join("\n"),
    8000,
  );
  const result = z
    .object({
      outcome: phrase,
      population: phrase,
      unit: phrase,
      timeframe: phrase,
      geography: phrase,
    })
    .safeParse(parsed);
  if (!result.success) {
    throw new Error("Claude returned components in an unexpected shape.");
  }
  return componentsFromExtracted(result.data);
}

function componentsFromExtracted(values: IndicatorComponents): IndicatorComponents {
  const components = emptyComponents();
  for (const kind of COMPONENT_KINDS) {
    components[kind] = values[kind];
  }
  return components;
}

export async function judgeComparability(request: CompareRequest): Promise<ComparabilityJudgment>;
export async function judgeComparability(request: ClusterRequest): Promise<ClusterJudgment>;
export async function judgeComparability(
  request: CompareRequest | ClusterRequest,
): Promise<ComparabilityJudgment | ClusterJudgment> {
  if (request.kind === "compare") {
    const parsed = await complete(
      [
        "Compare two impact indicators. Base the judgment on the five components.",
        "Use the definitions only to explain those components.",
        "For each of outcome, population, unit, timeframe, and geography, say whether they align and why.",
        "Grade the pair high only when the numbers could be compared, medium when the outcome is in the same family but a component differs, and low when they measure different things.",
        'Return JSON: {"outcome":{"aligns":true,"reason":""},"population":{"aligns":true,"reason":""},"unit":{"aligns":true,"reason":""},"timeframe":{"aligns":true,"reason":""},"geography":{"aligns":true,"reason":""},"grade":"high","summary":""}.',
        "summary is one sentence. grade is high, medium, or low.",
        "",
        sideBlock("Left", request.left),
        "",
        sideBlock("Right", request.right),
      ].join("\n"),
      16000,
    );
    const result = comparabilitySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Claude returned a comparison in an unexpected shape.");
    }
    return {
      components: {
        outcome: result.data.outcome,
        population: result.data.population,
        unit: result.data.unit,
        timeframe: result.data.timeframe,
        geography: result.data.geography,
      },
      grade: result.data.grade,
      summary: result.data.summary,
    };
  }

  const memberBlocks = request.members.map((member, index) => sideBlock(`Member ${index + 1}`, member));
  const parsed = await complete(
    [
      `These impact indicators were grouped in the sector "${request.sector}" because their wording is similar.`,
      "Write a short label, a one-sentence description, a comparability grade of high, medium, or low, and notes.",
      "In the notes, say whether outcome, population, unit, timeframe, and geography line up well enough that the numbers could be compared.",
      "Grade high only when those components line up, medium when some differ, and low when the numbers should not be compared.",
      'Return JSON: {"label":"","description":"","comparability_grade":"medium","comparability_notes":""}.',
      "",
      memberBlocks.join("\n\n"),
    ].join("\n"),
    16000,
  );
  const result = clusterSchema.safeParse(parsed);
  if (!result.success || !result.data.label || !result.data.description || !result.data.comparability_notes) {
    throw new Error("Claude returned a cluster label in an unexpected shape.");
  }
  return result.data;
}

function sideBlock(title: string, side: CompareSide): string {
  return [
    title + (side.name ? `: ${side.name}` : ""),
    `Definition: ${side.definition}`,
    formatComponents(side.components),
  ].join("\n");
}
