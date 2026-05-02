import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../documents/dto/document-retrieval-response.dto';

interface BuildGroundedAnswerUserPromptInput {
  userQuestion: string;
  answerLanguage: string | null;
  retrieval: DocumentRetrievalResponseDto;
}

export function buildGroundedAnswerSystemPrompt(
  evidenceQuality: DocumentRetrievalEvidenceQuality,
): string {
  const weakInstruction =
    evidenceQuality === 'weak'
      ? 'The evidence is weak. Be cautious, state that the evidence is limited, and do not present uncertain details as confirmed facts.'
      : 'The evidence is strong enough to answer, but you must still stay strictly grounded.';

  return [
    'You answer Trident document questions using only retrieved ship-document evidence.',
    'Do not use public web knowledge, generic maritime knowledge, or assumptions.',
    'Do not invent page numbers, section names, values, procedures, or requirements.',
    'Use citation markers like [1] or [2] for facts that come from the evidence.',
    'If you use retrieved evidence to answer, the final answer must include at least one citation marker.',
    'Every factual sentence grounded in retrieved evidence should carry a citation marker.',
    'Cite only evidence items that directly support the sentence or value you are writing.',
    'Do not cite generally related snippets, candidate chunks, document titles, or metadata as proof.',
    'If the evidence does not support part of the question, say that plainly.',
    'For numeric, table, specification, threshold, interval, capacity, voltage, pressure, power, model, alarm-code, or fault-code answers, report a value only when the exact value and unit appear in the cited evidence snippet.',
    'When evidence is tabular, preserve the row and column relationship exactly as shown in one cited evidence item.',
    'Do not infer from adjacent rows, combine unrelated rows or tables, add values together, convert units, or guess missing cells.',
    'If the row, model, column, value, or unit relationship is unclear, say the evidence is insufficient or ambiguous instead of giving a concrete value.',
    weakInstruction,
  ].join(' ');
}

export function buildGroundedAnswerUserPrompt(
  input: BuildGroundedAnswerUserPromptInput,
): string {
  return [
    `User question: ${input.userQuestion}`,
    `Preferred response language: ${input.answerLanguage ?? 'infer from the user question'}`,
    'Answer in the preferred response language unless the user explicitly requested another language.',
    'Do not mention or reveal internal retrieval-query normalization.',
    `Evidence quality: ${input.retrieval.evidenceQuality}`,
    `Answerability note: ${input.retrieval.answerability.reason}`,
    '',
    'Retrieved evidence:',
    ...input.retrieval.results.map((result) => formatEvidenceItem(result)),
    '',
    'Citation rule:',
    'Use [n] only when evidence item [n] directly supports the claim.',
    'If no evidence item directly supports the requested value, procedure, or fact, answer that the uploaded document evidence is insufficient and do not include citation markers.',
  ].join('\n');
}

export function formatEvidenceItem(
  result: DocumentRetrievalResultDto,
): string {
  return [
    `[${result.rank}] ${result.filename}`,
    `docClass: ${result.docClass}`,
    result.page ? `page: ${result.page}` : 'page: unknown',
    result.section ? `section: ${result.section}` : null,
    `snippet: ${result.snippet}`,
  ]
    .filter(Boolean)
    .join('\n');
}
