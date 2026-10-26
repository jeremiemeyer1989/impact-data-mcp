// The five parts of an indicator definition.
// Outcome, population, unit, timeframe, and geography are how the app decides
// whether two numbers can be compared. They are stored on the indicator and,
// when present, as one row per part.

export const COMPONENT_KINDS = [
  "outcome",
  "population",
  "unit",
  "timeframe",
  "geography",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export type IndicatorComponents = Record<ComponentKind, string>;

export function emptyComponents(): IndicatorComponents {
  return {
    outcome: "",
    population: "",
    unit: "",
    timeframe: "",
    geography: "",
  };
}

export function componentsFromValues(
  values: Partial<Record<ComponentKind, string | null | undefined>>,
): IndicatorComponents {
  const components = emptyComponents();
  for (const kind of COMPONENT_KINDS) {
    components[kind] = values[kind]?.trim() ?? "";
  }
  return components;
}

export function componentColumns(
  components: IndicatorComponents,
): Record<ComponentKind, string | null> {
  return {
    outcome: components.outcome || null,
    population: components.population || null,
    unit: components.unit || null,
    timeframe: components.timeframe || null,
    geography: components.geography || null,
  };
}

export function nonEmptyComponentRows(
  indicatorId: string,
  components: IndicatorComponents,
): { indicator_id: string; kind: ComponentKind; value: string }[] {
  return COMPONENT_KINDS.filter((kind) => components[kind].length > 0).map((kind) => ({
    indicator_id: indicatorId,
    kind,
    value: components[kind],
  }));
}
