import { ChatTurnAskResult } from '../../responders/interfaces/chat-turn-responder.types';

export function shouldOmitDocumentOnlyQuestionHeading(
  result: ChatTurnAskResult,
): boolean {
  const plan = getDocumentIntentPlan(result);

  return Boolean(
    plan &&
      (plan.answerMode === 'procedure' ||
        plan.asksForSteps === true ||
        plan.evidenceNeed === 'procedure_steps'),
  );
}

function getDocumentIntentPlan(
  result: ChatTurnAskResult,
): Record<string, unknown> | null {
  const data = result.data;
  const retrieval =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>).retrieval
      : null;
  const query =
    retrieval && typeof retrieval === 'object'
      ? (retrieval as Record<string, unknown>).query
      : null;
  const plan =
    query && typeof query === 'object'
      ? (query as Record<string, unknown>).intentPlan
      : null;

  return plan && typeof plan === 'object'
    ? (plan as Record<string, unknown>)
    : null;
}
