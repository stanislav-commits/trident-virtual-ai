import { ChatDocumentationQueryService } from './chat-documentation-query.service';

describe('ChatDocumentationQueryService', () => {
  const service = new ChatDocumentationQueryService();

  it('asks for clarification on broad maintenance questions without a concrete subject', () => {
    const userQuery = 'How do I change oil?';

    expect(
      service.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery: userQuery,
        previousUserQuery: null,
        pendingClarificationQuery: null,
      }),
    ).toBe(true);
    expect(service.buildClarificationQuestion(userQuery)).toContain(
      'Which exact component or system',
    );
  });

  it('does not ask for clarification when the subject is already specific enough', () => {
    const userQuery = 'How do I change oil in the port generator?';

    expect(
      service.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery: userQuery,
        previousUserQuery: null,
        pendingClarificationQuery: null,
      }),
    ).toBe(false);
  });

  it('reuses the previous vague query when the user replies to a clarification', () => {
    const pendingClarificationQuery = 'How do I change oil?';
    const userReply = 'in the port generator';

    expect(
      service.shouldTreatAsClarificationReply(
        userReply,
        pendingClarificationQuery,
      ),
    ).toBe(true);
    expect(
      service.buildClarificationResolvedQuery(
        pendingClarificationQuery,
        userReply,
      ),
    ).toBe('How do I change oil in the port generator');
  });

  it('treats a direct reference id reply as a clarification answer and resolves it into the original parts query', () => {
    const pendingClarificationQuery = 'What spare parts do I need?';
    const userReply = 'Reference ID 1P50';
    const retrievalQuery = service.buildClarificationResolvedQuery(
      pendingClarificationQuery,
      userReply,
    );

    expect(
      service.shouldTreatAsClarificationReply(
        userReply,
        pendingClarificationQuery,
      ),
    ).toBe(true);
    expect(retrievalQuery).toContain('What spare parts do I need');
    expect(retrievalQuery).toContain('Reference ID 1P50');
    expect(
      service.shouldAskClarifyingQuestion({
        userQuery: userReply,
        retrievalQuery,
        previousUserQuery: null,
        pendingClarificationQuery,
      }),
    ).toBe(false);
  });

  it('does not merge a fresh self-contained question into the previous clarification flow', () => {
    expect(
      service.shouldTreatAsClarificationReply(
        'How do I replace the impeller in the starboard generator?',
        'How do I change oil?',
      ),
    ).toBe(false);
  });

  it('inherits the previous subject for vague next-maintenance follow-up questions', () => {
    expect(
      service.buildRetrievalQuery(
        'when should we do next maintenance?',
        'what is running hours meter for port generator',
      ),
    ).toContain('port generator');
  });

  it('inherits the previous subject for vague last-due follow-up questions', () => {
    expect(
      service.buildRetrievalQuery(
        'what maintenance is last due?',
        'what is running hours meter for port generator',
      ),
    ).toContain('port generator');
  });

  it('inherits an exact maintenance row context for broad follow-up task questions', () => {
    const previousResolvedQuery =
      'M Y Seawolf X Maintenance Tasks Reference ID 1P47 PS ENGINE A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE';

    expect(
      service.buildRetrievalQuery(
        'what should I do at this maintenance?',
        previousResolvedQuery,
      ),
    ).toContain('1p47');
    expect(
      service.buildRetrievalQuery(
        'what spare parts are needed?',
        previousResolvedQuery,
      ),
    ).toContain('1p47');
    expect(
      service.buildRetrievalQuery(
        'what spare parts are needed?',
        previousResolvedQuery,
      ),
    ).toContain('main generator');
  });

  it('keeps short tasks-and-parts follow-ups attached to an exact reference context', () => {
    const previousResolvedQuery =
      'M Y Seawolf X Maintenance Tasks Reference ID 1P50 PS ENGINE E MAIN GENERATOR 3000 HOURS SERVICE';

    expect(
      service.buildRetrievalQuery('tasks and spare parts', previousResolvedQuery),
    ).toContain('1p50');
  });

  it('does not classify a maintenance procedure request as a parts-only query', () => {
    const query = 'I need the oil change procedure for the port generator.';

    expect(service.isProcedureQuery(query)).toBe(true);
    expect(service.isPartsQuery(query)).toBe(false);
  });

  it('still recognizes an explicit parts request when the user asks for procedure and part numbers together', () => {
    const query =
      'I need the oil change procedure and part numbers for the port generator.';

    expect(service.isProcedureQuery(query)).toBe(true);
    expect(service.isPartsQuery(query)).toBe(true);
  });

  it('forces generator asset fallback for procedure queries on a sided generator asset', () => {
    expect(
      service.shouldAugmentGeneratorAssetLookup(
        'How do I change oil in the port generator',
        'I need the oil change procedure for the port generator.',
      ),
    ).toBe(true);
    expect(
      service.buildGeneratorAssetFallbackQueries(
        'How do I change oil in the port generator',
        'I need the oil change procedure for the port generator.',
      ).some((query) => /PS ENGINE MAIN GENERATOR/i.test(query)),
    ).toBe(true);
    expect(
      service.buildGeneratorAssetFallbackQueries(
        'How do I change oil in the port generator',
        'I need the oil change procedure for the port generator.',
      ).some((query) => /replace oil and filters|oil/i.test(query)),
    ).toBe(true);
  });
});
