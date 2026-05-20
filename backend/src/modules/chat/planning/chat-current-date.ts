export interface CurrentDateReplyOptions {
  now?: Date;
  timeZone?: string;
}

export function buildCurrentDateReply(
  question: string,
  options: CurrentDateReplyOptions = {},
): string | null {
  if (!isCurrentDateQuestion(question)) {
    return null;
  }

  const now = options.now ?? new Date();
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const language = detectDateQuestionLanguage(question);

  if (language === 'uk') {
    return `Сьогодні ${formatDate(now, timeZone, 'uk-UA')} (часовий пояс сервера: ${timeZone}).`;
  }

  if (language === 'ru') {
    return `Сегодня ${formatDate(now, timeZone, 'ru-RU')} (часовой пояс сервера: ${timeZone}).`;
  }

  return `Today is ${formatDate(now, timeZone, 'en-US')} (server time zone: ${timeZone}).`;
}

export function isCurrentDateQuestion(question: string): boolean {
  const normalized = normalizeDateQuestion(question);

  if (!normalized || normalized.length > 140) {
    return false;
  }

  if (hasNonDateDomainIntent(normalized)) {
    return false;
  }

  const englishDateQuestion =
    isStandaloneEnglishDateQuestion(normalized) ||
    /^(?:please\s+)?(?:what is|what's)\s+(?:the\s+)?current\s+(?:date|day)$/u.test(
      normalized,
    ) ||
    /^(?:please\s+)?(?:today's|todays)\s+(?:date|day)$/u.test(normalized);
  const ukrainianDateQuestion =
    /^(?:який|яка|яке)\s+сьогодні\s+(?:день|дата|число)$/u.test(
      normalized,
    ) ||
    /^(?:сьогоднішня|поточна)\s+дата$/u.test(normalized);
  const russianDateQuestion =
    /^(?:какой|какая|какое)\s+сегодня\s+(?:день|дата|число)$/u.test(
      normalized,
    ) ||
    /^(?:сегодняшняя|текущая)\s+дата$/u.test(normalized);

  return englishDateQuestion || ukrainianDateQuestion || russianDateQuestion;
}

function isStandaloneEnglishDateQuestion(normalized: string): boolean {
  const ambientContext =
    '(?:today|now|right now|onboard|aboard|on board|on the ship|on this vessel|shipboard)';

  return (
    new RegExp(
      `^(?:please\\s+)?(?:what|which)\\s+(?:day|date)\\s+(?:is\\s+)?(?:today|it)(?:\\s+${ambientContext}){0,3}$`,
      'u',
    ).test(normalized) ||
    new RegExp(
      `^(?:please\\s+)?(?:what|which)\\s+(?:day|date)\\s+${ambientContext}\\s+(?:today|now)$`,
      'u',
    ).test(normalized)
  );
}

function hasNonDateDomainIntent(normalized: string): boolean {
  return /\b(?:alarm|certificate|document|due|equipment|generator|manual|maintenance|metric|pms|pressure|schedule|service|task|threshold|troubleshooting|work scope)\b/u.test(
    normalized,
  );
}

function detectDateQuestionLanguage(question: string): 'en' | 'uk' | 'ru' {
  const normalized = normalizeDateQuestion(question);

  if (/[іїєґ]/u.test(normalized) || /\b(?:сьогодні|який|яка|дата|число)\b/u.test(normalized)) {
    return 'uk';
  }

  if (/[ыэъ]/u.test(normalized) || /\b(?:сегодня|какой|какая|текущая)\b/u.test(normalized)) {
    return 'ru';
  }

  return 'en';
}

function formatDate(now: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(now);
}

function normalizeDateQuestion(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
