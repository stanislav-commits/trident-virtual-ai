import { DocumentRetrievalResponseDto } from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';
import { DocumentQueryPlan } from '../composite/document-composite-retrieval';
import {
  assessProcedureEvidenceSupport,
  buildMissingProcedureStepEvidenceSummary,
  buildRelatedProcedureEvidenceSummary,
  shouldRequireProcedureStepEvidence,
} from '../grounding/document-procedure-evidence';

export interface DocumentEvidenceSafetySummary {
  summary: string;
  groundingStatus: 'grounded' | 'insufficient';
  groundingReason?: string;
}

export function buildMaintenanceScheduleSafetySummary(
  retrieval: DocumentRetrievalResponseDto,
  queryPlan: DocumentQueryPlan,
): string | null {
  if (
    retrieval.evidenceQuality !== 'weak' ||
    !queryPlan.contextFacts.maintenanceScheduleQuestion
  ) {
    return null;
  }

  const scheduleResults = retrieval.results
    .filter(
      (result) =>
        result.docClass === DocumentDocClass.MANUAL &&
        isMaintenanceScheduleEvidence(result.snippet),
    )
    .slice(0, 3);

  if (!scheduleResults.length) {
    return null;
  }

  const citationText = scheduleResults
    .map((result) => `[${result.rank}]`)
    .join('');
  const intervalText = describeVisibleMaintenanceIntervals(
    scheduleResults.map((result) => result.snippet).join(' '),
  );
  const runningHours = queryPlan.contextFacts.runningHours;
  const contextSentence = runningHours
    ? `I considered the current running-hours value from this chat: ${runningHours} running hours.`
    : 'The manual should be interpreted as an interval-based schedule; I did not find a current running-hours value in the chat context.';
  const scheduleSentence = runningHours
    ? `The retrieved manual evidence is a periodic maintenance schedule, not an entry for the exact current-hour value.${intervalText} ${citationText}`
    : `The retrieved manual evidence is a periodic maintenance schedule with running-hour based intervals.${intervalText} ${citationText}`;
  const nextActionSentence = runningHours
    ? 'Use the vessel service history to decide the next action: check which scheduled service interval was last completed, then compare the current running hours with the manual schedule. If the relevant prior interval has not been completed, treat that service as due; otherwise plan toward the next scheduled interval.'
    : 'For a due-maintenance decision, the current running hours and the vessel service history are both needed to compare against the manual schedule.';

  return [
    contextSentence,
    scheduleSentence,
    `Because the indexed table text is weak and does not preserve the row/column mapping clearly enough, I cannot safely list the exact tasks due from these parsed chunks. ${citationText}`,
    nextActionSentence,
    'Confirm the exact task list against the original manual table before performing the work.',
  ].join(' ');
}

export function buildProcedureEvidenceSafetySummary(
  retrieval: DocumentRetrievalResponseDto,
  queryPlan: DocumentQueryPlan,
): DocumentEvidenceSafetySummary | null {
  if (!shouldRequireProcedureStepEvidence(queryPlan.intentPlan)) {
    return null;
  }

  const support = assessProcedureEvidenceSupport(
    retrieval,
    queryPlan.intentPlan,
  );

  if (support.directResults.length) {
    return null;
  }

  const exposeWeakRelatedEvidence = retrieval.evidenceQuality === 'strong';

  if (support.relatedResults.length) {
    return {
      summary: buildRelatedProcedureEvidenceSummary(support, {
        includeCitations: exposeWeakRelatedEvidence,
      }),
      groundingStatus: exposeWeakRelatedEvidence ? 'grounded' : 'insufficient',
      groundingReason: exposeWeakRelatedEvidence
        ? undefined
        : 'Only weak related procedure evidence was found, not direct evidence for the requested procedure.',
    };
  }

  const exposeMissingEvidence = retrieval.evidenceQuality === 'strong';

  return {
    summary: buildMissingProcedureStepEvidenceSummary(retrieval, {
      includeCitations: exposeMissingEvidence,
    }),
    groundingStatus: exposeMissingEvidence ? 'grounded' : 'insufficient',
    groundingReason: exposeMissingEvidence
      ? undefined
      : 'No direct procedure-step evidence was found for the requested procedure.',
  };
}

function isMaintenanceScheduleEvidence(snippet: string): boolean {
  const normalized = snippet.toLocaleLowerCase();

  return (
    normalized.includes('periodic checks and maintenance') ||
    normalized.includes('periodicchecksandmaintenance') ||
    normalized.includes('maintenance schedule') ||
    normalized.includes('performservice at intervalsindicated') ||
    /\bevery\s*\d{2,5}\s*(?:hrs?|hours?)\b/u.test(normalized)
  );
}

function describeVisibleMaintenanceIntervals(snippet: string): string {
  if (/\bevery\s*\d{2,5}\s*(?:hrs?|hours?)\b/iu.test(snippet)) {
    return ' It shows visible recurring running-hour interval headers, although the extracted table remains ambiguous.';
  }

  return ' It shows maintenance should be performed at indicated intervals.';
}
