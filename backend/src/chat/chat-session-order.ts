type SortableChatSession = {
  pinnedAt: Date | null;
  updatedAt: Date;
};

function compareDatesDesc(left: Date | null, right: Date | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.getTime() - left.getTime();
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

    const pinnedDiff = compareDatesDesc(left.pinnedAt, right.pinnedAt);
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }

    return right.updatedAt.getTime() - left.updatedAt.getTime();
  });
}
