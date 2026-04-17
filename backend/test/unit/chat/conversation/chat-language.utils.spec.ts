import {
  buildConversationalReply,
  isGreetingOnlyQuery,
} from '../../../../src/chat/conversation/chat-language.utils';

describe('chat language utils', () => {
  it('treats common greeting-only variants as deterministic small talk', () => {
    for (const query of ['hi', 'hi there', 'hello there!', 'hey team']) {
      expect(isGreetingOnlyQuery(query)).toBe(true);
      expect(buildConversationalReply(query)).toBe('Hello! How can I help you?');
    }
  });

  it('does not swallow substantive questions that start with greetings', () => {
    expect(isGreetingOnlyQuery('hi, what is the current fuel level?')).toBe(
      false,
    );
    expect(buildConversationalReply('hello there, show current alarms')).toBe(
      null,
    );
  });
});
