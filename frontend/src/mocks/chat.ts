import type { ChatSession, Message } from '../types/chat';

export const mockSessions: ChatSession[] = [
  { id: '1', title: 'Engine manual — cold start', lastMessageAt: '2026-02-22T10:30:00Z', messageCount: 4 },
  { id: '2', title: 'Bilge pump procedure', lastMessageAt: '2026-02-21T14:00:00Z', messageCount: 8 },
  { id: '3', title: 'Navigation lights checklist', lastMessageAt: '2026-02-20T09:15:00Z', messageCount: 2 },
];

export const mockMessagesBySession: Record<string, Message[]> = {
  '1': [
    { id: 'm1', role: 'user', content: 'What is the recommended procedure for a cold start?', createdAt: '2026-02-22T10:28:00Z' },
    {
      id: 'm2',
      role: 'assistant',
      content: 'According to the manual: allow the engine to idle for 2–3 minutes before applying load. Check oil pressure and coolant temperature before increasing RPM.',
      createdAt: '2026-02-22T10:28:15Z',
    },
    { id: 'm3', role: 'user', content: 'And in temperatures below 5°C?', createdAt: '2026-02-22T10:29:00Z' },
    {
      id: 'm4',
      role: 'assistant',
      content: 'Below 5°C, extend idle to at least 5 minutes and ensure the block heater has been used if available. See Section 4.2 for cold-weather operation.',
      createdAt: '2026-02-22T10:30:00Z',
    },
  ],
  '2': [
    { id: 'm5', role: 'user', content: 'How often should the bilge pump be tested?', createdAt: '2026-02-21T13:55:00Z' },
    {
      id: 'm6',
      role: 'assistant',
      content: 'Weekly under normal conditions; before every trip in heavy weather. Always check the strainer for debris.',
      createdAt: '2026-02-21T14:00:00Z',
    },
  ],
  '3': [
    { id: 'm7', role: 'user', content: 'Navigation lights checklist?', createdAt: '2026-02-20T09:14:00Z' },
    {
      id: 'm8',
      role: 'assistant',
      content: 'Port (red), starboard (green), stern (white), masthead if fitted. Verify all before sunset and after any fuse change.',
      createdAt: '2026-02-20T09:15:00Z',
    },
  ],
};
