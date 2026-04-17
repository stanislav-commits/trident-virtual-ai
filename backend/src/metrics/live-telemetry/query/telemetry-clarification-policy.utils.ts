import { parseTelemetryListRequest } from './telemetry-list-request.utils';

export function shouldOfferTelemetryClarification(
  query: string,
  resolvedSubjectQuery?: string,
): boolean {
  if (parseTelemetryListRequest(query, resolvedSubjectQuery) != null) {
    return false;
  }

  const searchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
  if (
    /\b(best\s+match|closest|matches?|related\s+metric|related\s+telemetry)\b/i.test(
      searchSpace,
    )
  ) {
    return false;
  }

  if (
    /\b(parts?|spares?|part\s*numbers?|consumables?|filters?)\b/i.test(
      searchSpace,
    )
  ) {
    return false;
  }

  const asksForActionFromReading =
    /\b(based\s+on|depending\s+on|according\s+to)\b[\s\S]{0,120}\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
      searchSpace,
    ) ||
    (/\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do|is\s+any\s+action\s+recommended|any\s+action\s+recommended|next\s+step|next\s+steps)\b/i.test(
      searchSpace,
    ) &&
      /\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
        searchSpace,
      ));

  const isProcedureLike =
    /\b(how\s+do\s+i|how\s+to|replace|change|install|remove|maintenance|service|procedure|steps?|manual|documentation)\b/i.test(
      searchSpace,
    );
  if (isProcedureLike && !asksForActionFromReading) {
    return false;
  }

  const asksForReading =
    /\b(current|currently|status|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|remaining|left|available|onboard)\b/i.test(
      searchSpace,
    ) ||
    /\bhow\s+much\b|\bhow\s+many\b/i.test(searchSpace) ||
    /\bfrom\s+telemetry\b|\bfrom\s+metrics\b/i.test(searchSpace);

  const mentionsTelemetrySignal =
    /\b(oil|fuel|coolant|fresh\s*water|seawater|water|tank|battery|depth|rudder|trim|temperature|temp|pressure|voltage|current|load|rpm|speed|level|flow|rate|generator|genset|engine|pump|compressor|sensor|meter)\b/i.test(
      searchSpace,
    );

  return (
    mentionsTelemetrySignal && (asksForReading || asksForActionFromReading)
  );
}
