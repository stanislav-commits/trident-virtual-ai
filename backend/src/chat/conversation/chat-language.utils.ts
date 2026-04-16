export type ChatResponseLanguage = 'en' | 'uk' | 'it' | 'ru';

type LocalizedVariants = {
  en: string;
  uk?: string;
  it?: string;
  ru?: string;
};

const UKRAINIAN_MARKERS =
  /(?:^|[\s,.!?;:()"'`«»])(привіт|вітаю|доброго|добрий|дякую|будь\s+ласка|що|який|яка|яке|які|коли|чому|для|цього|потрібно|має|можу)(?:$|[\s,.!?;:()"'`«»])/iu;
const RUSSIAN_MARKERS =
  /(?:^|[\s,.!?;:()"'`«»])(привет|здравствуйте|добрый|спасибо|пожалуйста|что|какой|какая|какое|какие|когда|почему|для|этого|нужно|можно)(?:$|[\s,.!?;:()"'`«»])/iu;
const ITALIAN_MARKERS =
  /\b(ciao|salve|buongiorno|buonasera|grazie|prego|certificato|scade|scadenza|modulo|tipo|della|delle|degli|dati|documento|quale|questo|questa|esatto)\b/iu;

const GREETING_PATTERNS = [
  /^\s*(?:hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening)\s*[!.?]*\s*$/iu,
  /^\s*(?:привіт|вітаю|доброго\s+дня|добрий\s+день|доброго\s+ранку|добрий\s+вечір)\s*[!.?]*\s*$/iu,
  /^\s*(?:привет|здравствуйте|добрый\s+день|доброе\s+утро|добрый\s+вечер)\s*[!.?]*\s*$/iu,
  /^\s*(?:ciao|salve|buongiorno|buonasera)\s*[!.?]*\s*$/iu,
];

const THANKS_PATTERNS = [
  /^\s*(?:thanks|thank\s+you|thx)\s*[!.?]*\s*$/iu,
  /^\s*(?:дякую|щиро\s+дякую|спасибі)\s*[!.?]*\s*$/iu,
  /^\s*(?:спасибо|благодарю)\s*[!.?]*\s*$/iu,
  /^\s*(?:grazie|molte\s+grazie)\s*[!.?]*\s*$/iu,
];

export function detectChatResponseLanguage(
  text: string,
): ChatResponseLanguage {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'en';
  }

  if (/[іїєґ]/iu.test(trimmed) || UKRAINIAN_MARKERS.test(trimmed)) {
    return 'uk';
  }

  if (/[ыэёъ]/iu.test(trimmed) || RUSSIAN_MARKERS.test(trimmed)) {
    return 'ru';
  }

  if (/[àèéìòù]/iu.test(trimmed) || ITALIAN_MARKERS.test(trimmed)) {
    return 'it';
  }

  return 'en';
}

export function describeChatResponseLanguage(
  language: ChatResponseLanguage,
): string {
  switch (language) {
    case 'uk':
      return 'Ukrainian';
    case 'it':
      return 'Italian';
    case 'ru':
      return 'Russian';
    default:
      return 'English';
  }
}

export function localizeChatText(
  queryOrLanguage: string | ChatResponseLanguage,
  variants: LocalizedVariants,
): string {
  const language =
    queryOrLanguage === 'en' ||
    queryOrLanguage === 'uk' ||
    queryOrLanguage === 'it' ||
    queryOrLanguage === 'ru'
      ? queryOrLanguage
      : detectChatResponseLanguage(queryOrLanguage);

  return variants[language] ?? variants.en;
}

export function isGreetingOnlyQuery(text: string): boolean {
  return GREETING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isThanksOnlyQuery(text: string): boolean {
  return THANKS_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildConversationalReply(text: string): string | null {
  if (isGreetingOnlyQuery(text)) {
    return localizeChatText(text, {
      en: 'Hello! How can I help you?',
      uk: 'Привіт! Чим можу допомогти?',
      it: 'Ciao! Come posso aiutarti?',
      ru: 'Привет! Чем могу помочь?',
    });
  }

  if (isThanksOnlyQuery(text)) {
    return localizeChatText(text, {
      en: "You're welcome. If you want, send the question or document topic and I'll look it up.",
      uk: 'Будь ласка. Якщо хочеш, напиши запит або тему документа, і я допоможу розібратися.',
      it: 'Prego. Se vuoi, scrivi la domanda o il tema del documento e lo controllo io.',
      ru: 'Пожалуйста. Если хочешь, напиши вопрос или тему документа, и я помогу разобраться.',
    });
  }

  return null;
}

export function localizeApproximateDuration(
  duration: string | null,
  queryOrLanguage: string | ChatResponseLanguage,
): string | null {
  if (!duration) {
    return null;
  }

  const language =
    queryOrLanguage === 'en' ||
    queryOrLanguage === 'uk' ||
    queryOrLanguage === 'it' ||
    queryOrLanguage === 'ru'
      ? queryOrLanguage
      : detectChatResponseLanguage(queryOrLanguage);

  switch (language) {
    case 'uk':
      return duration
        .replace(/\band\b/giu, 'і')
        .replace(/\byears\b/giu, 'роки')
        .replace(/\byear\b/giu, 'рік')
        .replace(/\bmonths\b/giu, 'місяці')
        .replace(/\bmonth\b/giu, 'місяць')
        .replace(/\bweeks\b/giu, 'тижні')
        .replace(/\bweek\b/giu, 'тиждень')
        .replace(/\bdays\b/giu, 'дні')
        .replace(/\bday\b/giu, 'день');
    case 'it':
      return duration
        .replace(/\band\b/giu, 'e')
        .replace(/\byears\b/giu, 'anni')
        .replace(/\byear\b/giu, 'anno')
        .replace(/\bmonths\b/giu, 'mesi')
        .replace(/\bmonth\b/giu, 'mese')
        .replace(/\bweeks\b/giu, 'settimane')
        .replace(/\bweek\b/giu, 'settimana')
        .replace(/\bdays\b/giu, 'giorni')
        .replace(/\bday\b/giu, 'giorno');
    case 'ru':
      return duration
        .replace(/\band\b/giu, 'и')
        .replace(/\byears\b/giu, 'года')
        .replace(/\byear\b/giu, 'год')
        .replace(/\bmonths\b/giu, 'месяцы')
        .replace(/\bmonth\b/giu, 'месяц')
        .replace(/\bweeks\b/giu, 'недели')
        .replace(/\bweek\b/giu, 'неделя')
        .replace(/\bdays\b/giu, 'дни')
        .replace(/\bday\b/giu, 'день');
    default:
      return duration;
  }
}
