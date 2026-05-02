import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResultDto,
} from '../../../documents/dto/document-retrieval-response.dto';
import { ChatSemanticDocumentCompositionMode } from '../../routing/chat-semantic-router.types';
import { formatEvidenceItem } from './document-grounded-answer-prompt';

export interface CompositeDocumentPromptComponent {
  id: string;
  label: string;
  question: string;
  documentTitleHint: string | null;
  evidenceQuality: DocumentRetrievalEvidenceQuality;
  answerabilityReason: string;
  evidenceItems: DocumentRetrievalResultDto[];
}

interface BuildCompositeDocumentAnswerUserPromptInput {
  userQuestion: string;
  answerLanguage: string | null;
  compositionMode: ChatSemanticDocumentCompositionMode | null;
  components: CompositeDocumentPromptComponent[];
}

export function buildCompositeDocumentAnswerSystemPrompt(): string {
  return [
    'You answer Trident document-only composite questions using only retrieved ship-document evidence.',
    'Do not use public web knowledge, metrics, telemetry, generic maritime knowledge, or assumptions.',
    'Keep document-backed claims tied to the component evidence that supports them.',
    'Use citation markers like [1] or [2] for facts that come from the evidence.',
    'If you use retrieved evidence to answer, the final answer must include at least one citation marker.',
    'Every factual sentence grounded in retrieved evidence should carry a citation marker.',
    'Cite only evidence items that directly support the sentence or value you are writing.',
    'Do not cite generally related snippets, candidate chunks, document titles, or metadata as proof.',
    'If one component has weak or no supporting evidence, state that this part is limited or could not be confirmed from uploaded documents.',
    'Do not report agreement, disagreement, conflicts, or missing requirements unless both relevant sides have evidence.',
    'For numeric, table, specification, threshold, interval, capacity, voltage, pressure, power, model, alarm-code, or fault-code answers, report a value only when the exact value and unit appear in the cited evidence snippet.',
    'When evidence is tabular, preserve the row and column relationship exactly as shown in one cited evidence item.',
    'Do not infer from adjacent rows, combine unrelated rows or tables, add values together, convert units, or guess missing cells.',
  ].join(' ');
}

export function buildCompositeDocumentAnswerUserPrompt(
  input: BuildCompositeDocumentAnswerUserPromptInput,
): string {
  return [
    `User question: ${input.userQuestion}`,
    `Preferred response language: ${input.answerLanguage ?? 'infer from the user question'}`,
    'Answer in the preferred response language unless the user explicitly requested another language.',
    'Do not mention or reveal internal retrieval-query normalization.',
    `Composition mode: ${input.compositionMode ?? 'synthesize'}`,
    '',
    'Component evidence:',
    ...input.components.flatMap((component) => [
      `Component ${component.id}: ${component.label}`,
      `Focused question: ${component.question}`,
      `Document title hint: ${component.documentTitleHint ?? 'none'}`,
      `Evidence quality: ${component.evidenceQuality}`,
      `Answerability note: ${component.answerabilityReason}`,
      ...(shouldExposeComponentEvidence(input.compositionMode, component)
        ? component.evidenceItems.map((result) => formatEvidenceItem(result))
        : [
            component.evidenceItems.length
              ? 'Weak tangential evidence was retrieved, but it is not enough to support this untitled compare component. Treat this component as unsupported and do not cite it.'
              : 'No retrieved evidence items for this component.',
          ]),
      '',
    ]),
    'Composition rules:',
    '- For compare or conflicts mode, separate what each component says before stating shared points or differences.',
    '- For procedure, checklist, or synthesize mode, produce a unified answer only from cited evidence and call out unsupported parts.',
    '- For summarize_by_source mode, keep the answer grouped by component/source.',
    '- Do not reuse citations from one component to support another component.',
    '- If all components have no usable evidence, say the uploaded documents do not provide enough support and do not include citation markers.',
  ].join('\n');
}

function shouldExposeComponentEvidence(
  compositionMode: ChatSemanticDocumentCompositionMode | null,
  component: CompositeDocumentPromptComponent,
): boolean {
  if (!component.evidenceItems.length) {
    return false;
  }

  if (
    (compositionMode === 'compare' || compositionMode === 'conflicts') &&
    component.evidenceQuality === 'weak' &&
    !component.documentTitleHint
  ) {
    return false;
  }

  return true;
}
