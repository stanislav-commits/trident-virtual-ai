import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertSessionAccess,
  encodeSessionCursor,
  formatMessageResponse,
  formatSessionResponse,
  normalizeSessionPageSize,
  parseSessionCursor,
} from '../../../../src/chat/session/chat-session.formatters';

describe('chat-session formatters', () => {
  describe('formatSessionResponse', () => {
    it('serialises dates to ISO strings and exposes isPinned', () => {
      const updatedAt = new Date('2026-04-01T12:00:00.000Z');
      const createdAt = new Date('2026-03-01T08:00:00.000Z');
      const pinnedAt = new Date('2026-04-02T09:30:00.000Z');

      const dto = formatSessionResponse({
        id: 'sess-1',
        title: 'My Chat',
        userId: 'u-1',
        shipId: 's-1',
        pinnedAt,
        createdAt,
        updatedAt,
        deletedAt: null,
      });

      expect(dto).toMatchObject({
        id: 'sess-1',
        title: 'My Chat',
        userId: 'u-1',
        shipId: 's-1',
        isPinned: true,
        pinnedAt: pinnedAt.toISOString(),
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        deletedAt: null,
      });
    });

    it('flags isPinned false when pinnedAt is null', () => {
      const dto = formatSessionResponse({
        id: 'sess-2',
        title: null,
        userId: 'u-1',
        shipId: null,
        pinnedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });

      expect(dto.isPinned).toBe(false);
      expect(dto.pinnedAt).toBeNull();
      expect(dto.title).toBeUndefined();
    });
  });

  describe('formatMessageResponse', () => {
    it('hoists shipManual.shipId/category onto the citation', () => {
      const dto = formatMessageResponse({
        id: 'm-1',
        role: 'assistant',
        content: 'hello',
        ragflowContext: { used: true },
        contextReferences: [
          {
            id: 'ref-1',
            shipManualId: 'man-1',
            chunkId: 'c-1',
            score: 0.9,
            pageNumber: 3,
            snippet: 'snip',
            sourceTitle: 'Manual',
            sourceUrl: 'https://example.com',
            shipManual: { shipId: 'ship-9', category: 'MANUAL' },
          },
        ],
        createdAt: new Date('2026-04-01T00:00:00Z'),
        deletedAt: null,
      });

      expect(dto.contextReferences).toHaveLength(1);
      expect(dto.contextReferences![0]).toMatchObject({
        shipId: 'ship-9',
        sourceCategory: 'MANUAL',
        shipManualId: 'man-1',
      });
    });

    it('defaults missing optional fields safely', () => {
      const dto = formatMessageResponse({
        id: 'm-2',
        role: 'user',
        content: 'hi',
        ragflowContext: null,
        contextReferences: [],
        createdAt: new Date(0),
        deletedAt: null,
      });

      expect(dto.ragflowContext).toBeNull();
      expect(dto.contextReferences).toEqual([]);
    });
  });

  describe('normalizeSessionPageSize', () => {
    it('returns the default when value is missing or NaN', () => {
      expect(normalizeSessionPageSize(undefined)).toBe(30);
      expect(normalizeSessionPageSize('not-a-number')).toBe(30);
    });

    it('clamps to [1, 100]', () => {
      expect(normalizeSessionPageSize(0)).toBe(1);
      expect(normalizeSessionPageSize(-5)).toBe(1);
      expect(normalizeSessionPageSize(200)).toBe(100);
      expect(normalizeSessionPageSize('50')).toBe(50);
    });
  });

  describe('parseSessionCursor / encodeSessionCursor', () => {
    it('round-trips a session cursor', () => {
      const cursor = encodeSessionCursor({
        id: 'sess-1',
        updatedAt: new Date('2026-04-01T10:00:00Z'),
      });
      const parsed = parseSessionCursor(cursor);
      expect(parsed).toEqual({
        id: 'sess-1',
        updatedAt: '2026-04-01T10:00:00.000Z',
      });
    });

    it('returns null when input is empty', () => {
      expect(parseSessionCursor(undefined)).toBeNull();
      expect(parseSessionCursor('   ')).toBeNull();
    });

    it('throws BadRequestException on tampered cursor', () => {
      expect(() => parseSessionCursor('not-base64-payload!!')).toThrow(
        BadRequestException,
      );
      const garbage = Buffer.from(JSON.stringify({ id: '' }), 'utf8').toString(
        'base64url',
      );
      expect(() => parseSessionCursor(garbage)).toThrow(BadRequestException);
    });
  });

  describe('assertSessionAccess', () => {
    it('passes silently when ownership matches', () => {
      expect(() =>
        assertSessionAccess({ userId: 'u-1' }, 'u-1', 'user'),
      ).not.toThrow();
    });

    it('throws ForbiddenException when ownership does not match', () => {
      expect(() =>
        assertSessionAccess({ userId: 'u-1' }, 'u-2', 'user'),
      ).toThrow(ForbiddenException);
    });
  });
});
