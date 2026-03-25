type SortableChatSession = {
  pinnedAt?: string | null;
  updatedAt: string;
};

function toTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortChatSessions<T extends SortableChatSession>(
  sessions: T[],
): T[] {
  return [...sessions].sort((left, right) => {
    const leftPinned = left.pinnedAt ? 1 : 0;
    const rightPinned = right.pinnedAt ? 1 : 0;

    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }

    const pinnedDiff = toTimestamp(right.pinnedAt) - toTimestamp(left.pinnedAt);
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }

    return toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
  });
}
