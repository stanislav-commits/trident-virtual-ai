export function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  for (const candidate of buildCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function buildCandidates(input: string): string[] {
  const candidates = new Set<string>([input]);

  if (input.startsWith('```')) {
    const lines = input.split('\n');
    const withoutFence = lines
      .slice(1)
      .filter((line, index, source) => {
        return !(index === source.length - 1 && line.trim().startsWith('```'));
      })
      .join('\n')
      .trim();

    if (withoutFence) {
      candidates.add(withoutFence);
    }
  }

  const firstBrace = input.indexOf('{');
  const lastBrace = input.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(input.slice(firstBrace, lastBrace + 1));
  }

  return [...candidates];
}
