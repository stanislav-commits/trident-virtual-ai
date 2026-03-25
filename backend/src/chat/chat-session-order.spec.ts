import { sortChatSessions } from './chat-session-order';

describe('sortChatSessions', () => {
  it('places pinned sessions first and sorts them by most recent pin time', () => {
    const sorted = sortChatSessions([
      {
        pinnedAt: null,
        updatedAt: new Date('2026-03-26T10:30:00Z'),
        id: 'recent-unpinned',
      },
      {
        pinnedAt: new Date('2026-03-26T10:00:00Z'),
        updatedAt: new Date('2026-03-26T09:00:00Z'),
        id: 'older-pin',
      },
      {
        pinnedAt: new Date('2026-03-26T11:00:00Z'),
        updatedAt: new Date('2026-03-26T08:00:00Z'),
        id: 'newer-pin',
      },
    ]);

    expect(sorted.map((session) => session.id)).toEqual([
      'newer-pin',
      'older-pin',
      'recent-unpinned',
    ]);
  });

  it('keeps unpinned sessions ordered by latest activity', () => {
    const sorted = sortChatSessions([
      {
        pinnedAt: null,
        updatedAt: new Date('2026-03-26T08:00:00Z'),
        id: 'older',
      },
      {
        pinnedAt: null,
        updatedAt: new Date('2026-03-26T09:00:00Z'),
        id: 'newer',
      },
    ]);

    expect(sorted.map((session) => session.id)).toEqual(['newer', 'older']);
  });
});
