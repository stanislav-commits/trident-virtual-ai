import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';
import {
  getDocumentsWebFallbackDiagnostics,
  sanitizeDocumentSummaryForWebFallback,
} from './chat-documents-web-fallback';

interface ComposedSourceResult {
  content: string;
  contextReferences: unknown[];
}

export function composeDocumentsAndWebResults(
  askResults: ChatTurnAskResult[],
): ComposedSourceResult | null {
  const documentSummaries: string[] = [];
  const webSummaries: string[] = [];
  const unsupportedResults = askResults.filter(
    (result) =>
      result.responder !== ChatTurnResponderKind.DOCUMENTS &&
      result.responder !== ChatTurnResponderKind.WEB_SEARCH,
  );

  if (unsupportedResults.length) {
    return null;
  }

  for (const result of askResults) {
    if (result.responder === ChatTurnResponderKind.DOCUMENTS) {
      const fallbackSections = getFallbackSummarySections(result);

      documentSummaries.push(
        sanitizeDocumentSummaryForWebFallback(
          fallbackSections.documentSummary ?? result.summary,
        ),
      );

      if (fallbackSections.webSummary) {
        webSummaries.push(fallbackSections.webSummary);
      }

      continue;
    }

    if (result.responder === ChatTurnResponderKind.WEB_SEARCH) {
      webSummaries.push(result.summary);
    }
  }

  if (!documentSummaries.length || !webSummaries.length) {
    return null;
  }

  return {
    content: [
      formatSummarySection('Ship documents', documentSummaries),
      formatSummarySection('Web information', webSummaries),
    ].join('\n\n'),
    contextReferences: askResults.flatMap(
      (result) => result.contextReferences ?? [],
    ),
  };
}

export function composeFallbackAwareDocumentResults(
  askResults: ChatTurnAskResult[],
): ComposedSourceResult | null {
  if (
    !askResults.length ||
    !askResults.every(
      (result) => result.responder === ChatTurnResponderKind.DOCUMENTS,
    ) ||
    !askResults.some(hasDocumentWebFallbackOutput)
  ) {
    return null;
  }

  return {
    content:
      askResults.length === 1
        ? getFallbackAwareSummary(askResults[0])
        : askResults
            .map((result) =>
              [result.question, getFallbackAwareSummary(result)]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n'),
    contextReferences: askResults.flatMap(
      (result) => result.contextReferences ?? [],
    ),
  };
}

export function hasDocumentWebFallbackOutput(
  result: ChatTurnAskResult,
): boolean {
  const diagnostics = getDocumentsWebFallbackDiagnostics(result);

  return diagnostics?.action === 'executed' || diagnostics?.action === 'failed';
}

function formatSummarySection(
  title: string,
  summaries: string[],
): string {
  if (summaries.length === 1) {
    return [title, summaries[0]].join('\n');
  }

  return [
    title,
    ...summaries.map((summary, index) =>
      [`Source ${index + 1}`, summary].join('\n'),
    ),
  ].join('\n\n');
}

function getFallbackAwareSummary(result: ChatTurnAskResult): string {
  const sections = getFallbackSummarySections(result);

  if (!sections.webSummary) {
    return result.summary;
  }

  return [
    [
      'Ship documents',
      sanitizeDocumentSummaryForWebFallback(
        sections.documentSummary ?? result.summary,
      ),
    ].join('\n'),
    ['Web information', sections.webSummary].join('\n'),
  ].join('\n\n');
}

function getFallbackSummarySections(result: ChatTurnAskResult): {
  documentSummary: string | null;
  webSummary: string | null;
} {
  const webFallback =
    result.data &&
    typeof result.data === 'object' &&
    'webFallback' in result.data &&
    result.data.webFallback &&
    typeof result.data.webFallback === 'object'
      ? (result.data.webFallback as Record<string, unknown>)
      : null;

  return {
    documentSummary:
      typeof webFallback?.documentSummary === 'string'
        ? webFallback.documentSummary
        : null,
    webSummary:
      typeof webFallback?.webSummary === 'string' ? webFallback.webSummary : null,
  };
}
