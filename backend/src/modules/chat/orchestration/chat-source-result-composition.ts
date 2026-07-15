import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';
import {
  getDocumentsWebFallbackDiagnostics,
  sanitizeDocumentSummaryForWebFallback,
} from './chat-documents-web-fallback';
import {
  composeFlowingSourceProse,
  OPEN_SOURCE_WEB_LEAD_IN,
} from './chat-source-aware-answer-formatting';

interface ComposedSourceResult {
  content: string;
  contextReferences: unknown[];
}

export function composeDocumentsAndWebResults(
  askResults: ChatTurnAskResult[],
): ComposedSourceResult | null {
  const documentSummaries: Array<{
    summary: string;
    repeatedLeadingText?: string;
  }> = [];
  const webSummaries: Array<{
    summary: string;
    repeatedLeadingText?: string;
  }> = [];
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

      documentSummaries.push({
        summary: sanitizeDocumentSummaryForWebFallback(
          fallbackSections.documentSummary ?? result.summary,
        ),
        repeatedLeadingText: result.question,
      });

      if (fallbackSections.webSummary) {
        webSummaries.push({
          summary: fallbackSections.webSummary,
          repeatedLeadingText: result.question,
        });
      }

      continue;
    }

    if (result.responder === ChatTurnResponderKind.WEB_SEARCH) {
      webSummaries.push({
        summary: result.summary,
        repeatedLeadingText: result.question,
      });
    }
  }

  if (!documentSummaries.length || !webSummaries.length) {
    return null;
  }

  return {
    content: composeFlowingSourceProse(documentSummaries, webSummaries, {
      webLeadIn: OPEN_SOURCE_WEB_LEAD_IN,
    }),
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

  const documentSummaries = askResults.map((result) => {
    const sections = getFallbackSummarySections(result);

    return {
      summary: sanitizeDocumentSummaryForWebFallback(
        sections.documentSummary ?? result.summary,
      ),
      repeatedLeadingText: result.question,
    };
  });
  const webSummaries = askResults.flatMap((result) => {
    const sections = getFallbackSummarySections(result);
    const failedFallbackSummary = getFailedFallbackWebSummary(result);

    return sections.webSummary
      ? [{ summary: sections.webSummary, repeatedLeadingText: result.question }]
      : failedFallbackSummary
        ? [{ summary: failedFallbackSummary }]
        : [];
  });

  return {
    content: composeFlowingSourceProse(documentSummaries, webSummaries, {
      webLeadIn: OPEN_SOURCE_WEB_LEAD_IN,
    }),
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

  const renderedWebSummary = hasDocumentWebFallbackOutput(result)
    ? getSourceAwareSectionBody(result.summary, 'Web information')
    : null;

  return {
    documentSummary:
      typeof webFallback?.documentSummary === 'string'
        ? webFallback.documentSummary
        : null,
    webSummary:
      renderedWebSummary ??
      (typeof webFallback?.webSummary === 'string' ? webFallback.webSummary : null),
  };
}

function getFailedFallbackWebSummary(result: ChatTurnAskResult): string | null {
  const diagnostics = getDocumentsWebFallbackDiagnostics(result);

  if (diagnostics?.action !== 'failed') {
    return null;
  }

  return getSourceAwareSectionBody(result.summary, 'Web information');
}

function getSourceAwareSectionBody(
  summary: string,
  title: string,
): string | null {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = summary.match(
    new RegExp(
      `(?:^|\\n)## ${escapedTitle}\\s*\\n+([\\s\\S]*?)(?=\\n\\n## |\\s*$)`,
      'u',
    ),
  );

  return match?.[1]?.trim() || null;
}
