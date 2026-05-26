export function getQuestionContentSignalBonus(
  question: string,
  content: string,
): number {
  if (!question.trim() || !content.trim()) {
    return 0;
  }

  const normalizedQuestion = normalizeSignalText(question);
  const normalizedContent = normalizeSignalText(content);
  let bonus = 0;

  if (isFuelFilterReplacementQuestion(normalizedQuestion)) {
    if (normalizedContent.includes('engine fuel filter replacement')) {
      bonus += 0.12;
    } else if (normalizedContent.includes('fuel filter replacement')) {
      bonus += 0.09;
    }

    if (
      normalizedContent.includes('unscrew the filter') ||
      normalizedContent.includes('screw on the new filter')
    ) {
      bonus += 0.08;
    }

    if (
      normalizedContent.includes('pump up fuel with the handpump') ||
      normalizedContent.includes('start the engine and check that there are no leaks')
    ) {
      bonus += 0.05;
    }
  }

  if (isMaintenanceScheduleQuestion(normalizedQuestion)) {
    if (
      normalizedContent.includes('periodic checks and maintenance') ||
      normalizedContent.includes('periodicchecksandmaintenance')
    ) {
      bonus += 0.1;
    }

    if (
      normalizedContent.includes('maintenance schedule') ||
      normalizedContent.includes('performservice at intervalsindicated')
    ) {
      bonus += 0.05;
    }
  }

  return Math.min(0.18, bonus);
}

export function isFuelFilterReplacementQuestion(value: string): boolean {
  const normalized = normalizeSignalText(value);

  return (
    /\bfuel\s*(?:pre\s*)?filter(?:s| cartridge| cartridges)?\b/u.test(
      normalized,
    ) &&
    /\b(?:change|changing|replace|replacing|replacement|renew|renewing|service|servicing|remove|removing|install|installing|procedure)\b/u.test(
      normalized,
    )
  );
}

export function isMaintenanceScheduleQuestion(value: string): boolean {
  const normalized = normalizeSignalText(value);

  return (
    /\b(?:maintenance|maintain|service|servicing|scheduled|schedule|interval|periodic checks|checks and maintenance|due|next)\b/u.test(
      normalized,
    ) &&
    /\b(?:next|due|scheduled|schedule|interval|periodic|running hours|run hours|hours|hrs|perform|performed)\b/u.test(
      normalized,
    )
  );
}

function normalizeSignalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
