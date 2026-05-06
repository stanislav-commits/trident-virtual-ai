export interface ParserFailureClassification {
  eligible: boolean;
  reason: string | null;
}

const RETRIABLE_MANUAL_PARSER_ERROR_PATTERNS: Array<{
  reason: string;
  pattern: RegExp;
}> = [
  {
    reason: 'deepdoc_page_chars_missing',
    pattern: /page_chars/i,
  },
  {
    reason: 'parser_index_error',
    pattern: /list index out of range/i,
  },
  {
    reason: 'ragflow_chunking_internal_error',
    pattern: /internal server error while chunking/i,
  },
  {
    reason: 'empty_parse_tasks',
    pattern:
      /\b(empty|no)\s+parse\s+tasks?\b|parse_task_array|data_source\[0\]|bulk_insert_into_db/i,
  },
  {
    reason: 'pdf_decompression_error',
    pattern: /data-loss while decompressing corrupted data|decompressing corrupted data/i,
  },
  {
    reason: 'pdf_parser_failure',
    pattern:
      /\bpdf\b[\s\S]{0,100}\b(parser|parse|pdfplumber|decompress|corrupt|syntax|object|crop|coordinate|failed|failure|error)\b/i,
  },
  {
    reason: 'pdf_parser_failure',
    pattern:
      /\b(parser|parse|pdfplumber|decompress|corrupt|syntax|object|crop|coordinate|failed|failure|error)\b[\s\S]{0,100}\bpdf\b/i,
  },
  {
    reason: 'deepdoc_parser_failure',
    pattern: /\bdeepdoc\b[\s\S]{0,100}\b(parser|parse|failed|failure|error|chunking)\b/i,
  },
  {
    reason: 'deepdoc_parser_failure',
    pattern: /\b(parser|parse|failed|failure|error|chunking)\b[\s\S]{0,100}\bdeepdoc\b/i,
  },
];

export function classifyManualParserFailure(
  error: unknown,
): ParserFailureClassification {
  const message = normalizeErrorMessage(error);

  if (!message) {
    return { eligible: false, reason: null };
  }

  for (const { reason, pattern } of RETRIABLE_MANUAL_PARSER_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { eligible: true, reason };
    }
  }

  return { eligible: false, reason: null };
}

export function isRetriableManualParserFailure(error: unknown): boolean {
  return classifyManualParserFailure(error).eligible;
}

export function normalizeErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error === null || error === undefined
          ? ''
          : String(error);

  return rawMessage.replace(/\s+/g, ' ').trim();
}
