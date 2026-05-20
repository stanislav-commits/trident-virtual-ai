import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';

export interface MetricThresholdSafetyReply {
  content: string;
  contextReferences: unknown[];
}

export function buildMetricThresholdSafetyReply(input: {
  latestUserMessage: string;
  askResults: ChatTurnAskResult[];
}): MetricThresholdSafetyReply | null {
  if (!asksForMetricJudgment(input.latestUserMessage)) {
    return null;
  }

  const metricResults = input.askResults.filter(
    (result) => result.responder === ChatTurnResponderKind.METRICS,
  );

  if (!metricResults.length || hasThresholdEvidence(input.askResults)) {
    return null;
  }

  const metricSummaries = metricResults
    .map((result) => result.summary.trim())
    .filter(Boolean);

  if (!metricSummaries.length) {
    return null;
  }

  return {
    content: [
      ...metricSummaries,
      'I do not have cited threshold, alarm-limit, minimum, maximum, or normal-range evidence in this answer, so I cannot determine whether that value is normal, abnormal, too low, too high, or in alarm.',
    ].join('\n\n'),
    contextReferences: metricResults.flatMap(
      (result) => result.contextReferences ?? [],
    ),
  };
}

function asksForMetricJudgment(question: string): boolean {
  const normalized = normalize(question);

  return /\b(?:alarm|alarm limit|abnormal|danger|dangerous|normal|safe|threshold|too high|too low|within range|outside range|limit|limits)\b/u.test(
    normalized,
  );
}

function hasThresholdEvidence(results: ChatTurnAskResult[]): boolean {
  return results.some((result) => {
    if (result.responder !== ChatTurnResponderKind.DOCUMENTS) {
      return false;
    }

    const references = result.contextReferences ?? [];

    return references.some((reference) =>
      hasThresholdSignal(extractReferenceText(reference)),
    );
  });
}

function extractReferenceText(reference: unknown): string {
  if (!reference || typeof reference !== 'object') {
    return '';
  }

  const record = reference as Record<string, unknown>;

  return [record.sourceTitle, record.snippet]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function hasThresholdSignal(value: string): boolean {
  const normalized = normalize(value);

  return (
    /\b(?:alarm|alarm limit|limit|limits|maximum|minimum|max|min|normal range|operating range|range|threshold|warning)\b/u.test(
      normalized,
    ) && /\d/u.test(normalized)
  );
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
