const DOCUMENT_EXTENSION_PATTERN =
  /\.(?:pdf|docx?|xlsx?|pptx?)(?=$|[^\p{L}\p{N}])/iu;
const FILENAME_WITH_EXTENSION_PATTERN =
  /[\p{L}\p{N}][\p{L}\p{N} _.\/()&+'-]{0,180}\.(?:pdf|docx?|xlsx?|pptx?)(?=$|[^\p{L}\p{N}])/giu;
const QUOTED_TITLE_PATTERN =
  /["`\u201c\u201d\u2018\u2019]([^"`\u201c\u201d\u2018\u2019]{3,180})["`\u201c\u201d\u2018\u2019]/gu;
const HAS_UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const STARTS_WITH_UPPERCASE_LETTER = /^\p{Lu}/u;
const HAS_STRUCTURAL_TITLE_MARKER = /[\p{N}._\/()&+'-]/u;
const ACRONYM_LIKE_TOKEN = /^[\p{Lu}\p{N}._\/()&+'-]{2,}$/u;

export function extractDocumentTitleHint(question: string): string | null {
  const normalizedQuestion = question.trim();

  if (!normalizedQuestion) {
    return null;
  }

  return (
    extractFilenameLikeHint(normalizedQuestion) ??
    extractQuotedTitleHint(normalizedQuestion)
  );
}

function extractFilenameLikeHint(question: string): string | null {
  const matches = question.match(FILENAME_WITH_EXTENSION_PATTERN);

  for (const match of matches ?? []) {
    const cleaned = cleanTitleHint(extractTrailingFilenameCandidate(match));

    if (isUsableTitleHint(cleaned) && DOCUMENT_EXTENSION_PATTERN.test(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

function extractQuotedTitleHint(question: string): string | null {
  let match: RegExpExecArray | null;

  QUOTED_TITLE_PATTERN.lastIndex = 0;
  while ((match = QUOTED_TITLE_PATTERN.exec(question)) !== null) {
    const cleaned = cleanTitleHint(match[1]);

    if (isUsableTitleHint(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

function cleanTitleHint(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`([{]+|[\s"'`)\]}.,:;?!]+$/g, '')
    .trim();
}

function isUsableTitleHint(value: string): boolean {
  return (
    HAS_UNICODE_LETTER_OR_NUMBER.test(value) &&
    value.length >= 3 &&
    value.length <= 180
  );
}

function extractTrailingFilenameCandidate(value: string): string {
  const cleaned = cleanTitleHint(value);
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  if (tokens.length <= 1) {
    return cleaned;
  }

  let startIndex = tokens.length - 1;

  while (
    startIndex > 0 &&
    isStructurallyTitleLikeToken(tokens[startIndex - 1])
  ) {
    startIndex -= 1;
  }

  return tokens.slice(startIndex).join(' ');
}

function isStructurallyTitleLikeToken(token: string): boolean {
  return (
    STARTS_WITH_UPPERCASE_LETTER.test(token) ||
    HAS_STRUCTURAL_TITLE_MARKER.test(token) ||
    ACRONYM_LIKE_TOKEN.test(token)
  );
}
