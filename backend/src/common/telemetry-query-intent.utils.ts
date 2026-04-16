export interface CurrentInventoryTelemetryQueryOptions {
  includeFluidTankInventoryPhrase?: boolean;
  includeDefUreaAggregates?: boolean;
}

export const isTelemetryInventoryListQuery = (query: string): boolean => {
  const asksForInventory =
    /\b(show|display|give|return|output|write|provide|enumerate)\b/i.test(
      query,
    ) ||
    /^\s*list\b/i.test(query) ||
    /\b(?:can|could|would|will|please)\s+(?:you\s+)?list\b/i.test(query) ||
    /\blist\s+of\b/i.test(query) ||
    /\b(all|available|full|complete|entire|every|random|\d{1,2})\b/i.test(
      query,
    );
  const mentionsTelemetryInventory =
    /\b(metrics?|telemetry|readings?|values?|signals?|sensor(?:s)?)\b/i.test(
      query,
    ) ||
    (/\b(alarms?|warnings?|faults?|trips?)\b/i.test(query) &&
      asksForInventory);

  return mentionsTelemetryInventory && asksForInventory;
};

export const isStrictTelemetryInventoryListQuery = (
  query: string,
): boolean => {
  return (
    /\b(show|list|display|give|return|output)\b/i.test(query) &&
    /\b(metrics?|telemetry|readings?|values?)\b/i.test(query) &&
    /\b(active|connected|enabled|current|random|\d{1,2})\b/i.test(query)
  );
};

export const isCurrentInventoryTelemetryQuery = (
  query: string,
  options: CurrentInventoryTelemetryQueryOptions = {},
): boolean => {
  const normalized = query.toLowerCase();
  if (
    /\b(next\s+month|next\s+week|forecast|budget|trend|historical|history|over\s+the\s+last|last\s+\d+\s+(?:days?|weeks?|months?)|need\s+to\s+order|order)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  const tankInventoryPhrasePattern = options.includeFluidTankInventoryPhrase
    ? /\b(onboard|on\s+board|in\s+(?:the\s+)?tanks?|tank\s+levels?|all\s+(?:fuel|oil|water|coolant|def)\s+tanks|remaining|available)\b/i
    : /\b(onboard|on\s+board|in\s+(?:the\s+)?tanks?|tank\s+levels?|all\s+fuel\s+tanks|remaining|available)\b/i;
  const aggregateFluidPattern = options.includeDefUreaAggregates
    ? /\b(fuel|oil|water|coolant|def|urea)\b/i
    : /\b(fuel|oil|water|coolant)\b/i;

  return (
    tankInventoryPhrasePattern.test(normalized) ||
    (/\b(fuel|oil|water|coolant|def|urea)\b/i.test(normalized) &&
      /\b(level|levels|quantity|amount|volume|contents?)\b/i.test(
        normalized,
      ) &&
      /\b(tank|tanks)\b/i.test(normalized)) ||
    (/\b(how\s+many|how\s+much|total|combined|sum)\b/i.test(normalized) &&
      aggregateFluidPattern.test(normalized))
  );
};
