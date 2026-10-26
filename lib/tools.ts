// The four MCP tools.
// Each description tells a client model when to call the tool. The handlers
// return plain text or JSON the caller can read.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compareDefinitions, findPeers, searchIndicators, submitIndicator } from "./indicators";

const searchSchema = z.object({
  query: z.string().trim().min(1),
  sector: z.string().trim().min(1).optional(),
  geography: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(25).default(8),
});

const compareSchema = z
  .object({
    indicator_a_id: z.uuid().optional(),
    indicator_b_id: z.uuid().optional(),
    definition_a: z.string().trim().min(1).optional(),
    definition_b: z.string().trim().min(1).optional(),
    name_a: z.string().trim().min(1).optional(),
    name_b: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasIds = Boolean(value.indicator_a_id && value.indicator_b_id);
    const hasDefinitions = Boolean(value.definition_a && value.definition_b);
    if (!hasIds && !hasDefinitions) {
      ctx.addIssue(
        "Provide indicator_a_id and indicator_b_id, or definition_a and definition_b.",
      );
    }
  });

const submitSchema = z.object({
  organization_name: z.string().trim().min(1),
  sector: z.string().trim().min(1),
  name: z.string().trim().min(1),
  definition: z.string().trim().min(1),
  geography: z.string().trim().min(1).optional(),
  website: z.string().trim().min(1).optional(),
});

const peersSchema = z
  .object({
    indicator_id: z.uuid().optional(),
    organization_id: z.uuid().optional(),
    limit: z.number().int().min(1).default(8),
  })
  .superRefine((value, ctx) => {
    const chosen = Number(Boolean(value.indicator_id)) + Number(Boolean(value.organization_id));
    if (chosen !== 1) {
      ctx.addIssue("Provide either indicator_id or organization_id.");
    }
  });

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (
    message.includes("sk-") ||
    message.includes("MCP_API_KEY") ||
    message.toLowerCase().includes("service_role")
  ) {
    return "The request failed. Check the server configuration.";
  }
  return message;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function run(action: () => Promise<string>) {
  try {
    return textResult(await action());
  } catch (error) {
    return textResult(publicError(error), true);
  }
}

export function registerImpactTools(server: McpServer): void {
  server.registerTool(
    "search_indicators",
    {
      title: "Search indicators",
      description:
        "Search saved impact indicators by meaning. Call this when someone describes an outcome, a metric, or a population and wants indicators that measure something similar. Each result includes the definition, the organization, outcome, population, unit, timeframe, geography, and a cosine similarity. Use sector and geography only to narrow the search. limit defaults to 8 and must be from 1 to 25.",
      inputSchema: searchSchema,
    },
    async (input) =>
      run(async () => JSON.stringify(await searchIndicators(input), null, 2)),
  );

  server.registerTool(
    "compare_definitions",
    {
      title: "Compare definitions",
      description:
        "Judge whether two indicators measure the same thing closely enough that their numbers could be compared. Call this with indicator_a_id and indicator_b_id when the indicators are already stored, or with definition_a and definition_b for text that should not be saved. name_a and name_b are optional labels. If both ids and definitions are sent, the stored indicators are used. The result grades outcome, population, unit, timeframe, and geography, and ends with high, medium, or low.",
      inputSchema: compareSchema,
    },
    async (input) =>
      run(() =>
        compareDefinitions({
          indicatorAId: input.indicator_a_id,
          indicatorBId: input.indicator_b_id,
          definitionA: input.definition_a,
          definitionB: input.definition_b,
          nameA: input.name_a,
          nameB: input.name_b,
        }),
      ),
  );

  server.registerTool(
    "submit_indicator",
    {
      title: "Submit an indicator",
      description:
        "Save a new indicator for an organization. Call this when someone wants to add an indicator to the library. The organization is found or created by name. Claude extracts outcome, population, unit, timeframe, and geography from the definition. A geography argument overrides the extracted geography. The indicator is embedded and attached to the nearest cluster in the same sector when it is close enough. This tool does not create a new cluster.",
      inputSchema: submitSchema,
    },
    async (input) =>
      run(async () =>
        JSON.stringify(
          await submitIndicator({
            organizationName: input.organization_name,
            sector: input.sector,
            name: input.name,
            definition: input.definition,
            geography: input.geography,
            website: input.website,
          }),
          null,
          2,
        ),
      ),
  );

  server.registerTool(
    "find_peers",
    {
      title: "Find peers",
      description:
        "Find indicators or organizations that measure something similar. Call this with indicator_id to list other indicators in the same cluster, or with organization_id to list organizations that share a cluster. Pass exactly one id. limit defaults to 8. An unclustered indicator falls back to the nearest indicators in its sector. An organization with no clustered indicators falls back to the nearest indicators from other organizations. overlap_count is how many indicators from the two organizations sit in that shared cluster.",
      inputSchema: peersSchema,
    },
    async (input) =>
      run(async () =>
        JSON.stringify(
          await findPeers({
            indicatorId: input.indicator_id,
            organizationId: input.organization_id,
            limit: input.limit,
          }),
          null,
          2,
        ),
      ),
  );
}
