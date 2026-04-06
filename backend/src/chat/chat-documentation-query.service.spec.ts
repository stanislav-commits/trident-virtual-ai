import { ChatDocumentationQueryService } from './chat-documentation-query.service';

describe('ChatDocumentationQueryService', () => {
  const service = new ChatDocumentationQueryService();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-31T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

  it('does not ask for clarification when a procedure query already names a qualified component target', () => {
    const userQuery = 'How do I replace the oil filter?';

    expect(
      service.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery: userQuery,
        previousUserQuery: null,
        pendingClarificationQuery: null,
      }),
    ).toBe(false);
  });

  it('asks for clarification on broad next-due maintenance questions without an asset or task anchor', () => {
    const userQuery = 'When is the next maintenance due?';

    expect(
      service.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery: userQuery,
        previousUserQuery: null,
        pendingClarificationQuery: null,
      }),
    ).toBe(true);
    expect(service.buildClarificationQuestion(userQuery)).toContain(
      'Which exact asset, component, maintenance task, or reference ID',
    );
  });

  it('does not ask for clarification on next-due maintenance questions when a concrete asset is already named', () => {
    const userQuery = 'When is the next maintenance on the port generator due?';

    expect(
      service.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery: userQuery,
        previousUserQuery: null,
        pendingClarificationQuery: null,
      }),
    ).toBe(false);
  });

  it('recognizes generic due-date maintenance phrasing as a next-due lookup', () => {
    expect(
      service.isNextDueLookupQuery(
        'When is the starboard engine oil change due?',
      ),
    ).toBe(true);
  });

  it('recognizes remaining-hours maintenance phrasing as a next-due lookup', () => {
    expect(
      service.isNextDueLookupQuery(
        'How many hours remain until the next annual service on the starboard generator?',
      ),
    ).toBe(true);
  });

  it('does not ask for clarification for broader asset lookups that already name one concrete subject', () => {
    const userQuery = 'What spare parts do I need for the compressor?';

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

  it('inherits the previous subject for pronoun-based contact detail follow-ups', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'provide his contacts',
      "who is vessel's dpa?",
    );

    expect(retrievalQuery).toContain('vessel');
    expect(retrievalQuery).toContain('dpa');
    expect(retrievalQuery).toContain('contact details');
    expect(
      service.shouldPromoteRetrievalQueryToAnswerQuery(
        'provide his contacts',
        "who is vessel's dpa?",
        retrievalQuery,
      ),
    ).toBe(true);
  });

  it('inherits the previous subject for bare contact-detail shorthand follow-ups', () => {
    expect(
      service.buildRetrievalQuery('contacts', "who is vessel's dpa?"),
    ).toBe('vessel dpa contact details');

    expect(
      service.buildRetrievalQuery('email only', 'vessel dpa contact details'),
    ).toBe('vessel dpa contact email');
  });

  it('preserves the previous historical time anchor for completeness follow-ups', () => {
    expect(
      service.buildRetrievalQuery(
        'you missed 3 tanks',
        'how much total fuel was 5 days ago?',
      ),
    ).toBe('how much total fuel was 5 days ago show all available');

    expect(
      service.buildRetrievalQuery(
        'show all available',
        'how much total fuel was yesterday?',
      ),
    ).toBe('how much total fuel was yesterday show all available');
  });

  it('rewrites explicit current-time follow-ups onto the previous historical subject', () => {
    expect(
      service.buildRetrievalQuery(
        'what about now?',
        'how much total fuel was 5 days ago?',
      ),
    ).toBe('how much total fuel is in the tanks right now');

    expect(
      service.buildRetrievalQuery(
        'what about now?',
        'how much total fuel was 5 days ago show all available',
      ),
    ).toBe('how much total fuel is in the tanks right now');
  });

  it('normalizes short clarification replies that only select contact details', () => {
    const pendingClarificationQuery = 'emergency dpa contacts';
    const userReply = 'yes, contact details';

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
    ).toBe('emergency dpa contacts contact details');
  });

  it('extracts role anchors for contact lookups without keeping generic contact scaffolding', () => {
    expect(service.isContactLookupQuery('provide his contacts')).toBe(true);
    expect(
      service.extractContactAnchorTerms('who vessel dpa contact details'),
    ).toEqual(['dpa']);
    expect(
      service.extractContactAnchorTerms(
        'emergency operations director contact details',
      ),
    ).toEqual(['operations', 'director']);
  });

  it('treats role-based personnel lookups as directory queries and singularizes role anchors', () => {
    expect(service.isPersonnelDirectoryQuery('list all managers')).toBe(true);
    expect(service.extractContactAnchorTerms('list all managers')).toEqual([
      'manager',
    ]);
  });

  it('keeps explicit personnel role lookups self-contained instead of inheriting the previous subject', () => {
    expect(
      service.buildRetrievalQuery(
        'list all managers with their contact details',
        "who is vessel's dpa?",
      ),
    ).toBe('manager contact details');

    expect(
      service.buildRetrievalQuery(
        'who else has the dpa role?',
        "who is vessel's dpa?",
      ),
    ).toBe('dpa contact details');
  });

  it('does not confuse role-holder lookup with role inventory or role description intents', () => {
    expect(service.isRoleInventoryQuery('who else has the dpa role?')).toBe(
      false,
    );
    expect(
      service.isPersonnelDirectoryQuery('who else has the dpa role?'),
    ).toBe(true);
    expect(service.isPersonnelDirectoryQuery('what is the role of dpa?')).toBe(
      false,
    );
  });

  it('treats explicit role-description questions as self-contained even after a personnel lookup', () => {
    expect(
      service.buildRetrievalQuery(
        'what is the role of dpa?',
        'list all managers with their contact details',
      ),
    ).toBe('what is the role of dpa?');
  });

  it('drops document scaffolding from director-list personnel queries', () => {
    expect(
      service.extractContactAnchorTerms(
        'show all directors from the company contact details document',
      ),
    ).toEqual(['director']);
    expect(
      service.buildRetrievalQuery(
        'show all directors from the company contact details document',
        null,
      ),
    ).toBe('director contact details');
  });

  it('inherits the previous subject for role-inventory follow-up questions', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'what other roles are there?',
      "who is vessel's dpa?",
    );

    expect(retrievalQuery).toContain('vessel');
    expect(retrievalQuery).toContain('dpa');
    expect(retrievalQuery).toContain('roles');
    expect(
      service.shouldPromoteRetrievalQueryToAnswerQuery(
        'what other roles are there?',
        "who is vessel's dpa?",
        retrievalQuery,
      ),
    ).toBe(true);
  });

  it('inherits the previous subject for vague other-one follow-ups', () => {
    expect(
      service.buildRetrievalQuery(
        'what about the other one?',
        'vessel dpa contact email',
      ),
    ).toBe('vessel dpa contact email what about the other one?');
  });

  it('preserves substantive section hints when scoping a follow-up to the same manual', () => {
    const previous =
      'volvo penta d13 operator manual handle alarms from documentation';
    const retrievalQuery = service.buildRetrievalQuery(
      'What does the emergency section say in this manual?',
      previous,
    );

    expect(retrievalQuery).toContain('volvo penta d13 operator manual');
    expect(retrievalQuery).toContain('emergency section');
    expect(retrievalQuery).not.toBe(previous);
  });

  it('reuses the previous subject for contextual summary follow-ups', () => {
    expect(
      service.buildRetrievalQuery(
        'summarize that in one line',
        'what is the role of dpa?',
      ),
    ).toBe('what is the role of dpa?');
    expect(service.isSummaryFollowUpQuery('summarize that in one line')).toBe(
      true,
    );
  });

  it('does not treat standalone summary requests as contextual follow-ups', () => {
    expect(service.isSummaryFollowUpQuery('summarize all tanks')).toBe(false);
  });

  it('inherits the previous certificate subject for completeness-check follow-ups', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'Are you sure there are all certificates?',
      'write the list of expired certificates',
    );

    expect(retrievalQuery).toContain('expired');
    expect(retrievalQuery).toContain('certificates');
    expect(
      service.shouldPromoteRetrievalQueryToAnswerQuery(
        'Are you sure there are all certificates?',
        'write the list of expired certificates',
        retrievalQuery,
      ),
    ).toBe(true);
  });

  it('inherits the previous subject for vague next-maintenance follow-up questions', () => {
    expect(
      service.buildRetrievalQuery(
        'when should we do next maintenance?',
        'what is running hours meter for port generator',
      ),
    ).toContain('port generator');
  });

  it('inherits the full previous analytical question for temporal forecast follow-ups', () => {
    expect(
      service.buildRetrievalQuery(
        'based on the last month',
        'calculate how many fuel do i need for the next month?',
      ),
    ).toBe(
      'calculate how many fuel do i need for the next month based on the last month',
    );
  });

  it('inherits the previous subject for explicit telemetry-source override follow-ups', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'based on telemetry',
      'when and which was the bilge alarm last activated?',
    );

    expect(retrievalQuery).toContain('bilge alarm');
    expect(retrievalQuery).toContain('last activated');
    expect(retrievalQuery).toContain('from telemetry');
    expect(
      service.shouldPromoteRetrievalQueryToAnswerQuery(
        'based on telemetry',
        'when and which was the bilge alarm last activated?',
        retrievalQuery,
      ),
    ).toBe(true);
  });

  it('inherits the previous subject for completeness-correction follow-ups', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'you missed a lot of bilge alarms, write all',
      'list all available bilge alarm metrics',
    );

    expect(retrievalQuery).toContain('bilge alarm metrics');
    expect(retrievalQuery).toContain('show all available');
  });

  it('skips documentation retrieval for explicit telemetry-source override follow-ups', () => {
    expect(service.shouldSkipDocumentationRetrieval('based on telemetry')).toBe(
      true,
    );
    expect(
      service.shouldSkipDocumentationRetrieval('navigation.log in telemetry'),
    ).toBe(true);
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
      service.buildRetrievalQuery(
        'tasks and spare parts',
        previousResolvedQuery,
      ),
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
      service
        .buildGeneratorAssetFallbackQueries(
          'How do I change oil in the port generator',
          'I need the oil change procedure for the port generator.',
        )
        .some((query) => /PS ENGINE MAIN GENERATOR/i.test(query)),
    ).toBe(true);
    expect(
      service
        .buildGeneratorAssetFallbackQueries(
          'How do I change oil in the port generator',
          'I need the oil change procedure for the port generator.',
        )
        .some((query) => /replace oil and filters|oil/i.test(query)),
    ).toBe(true);
  });

  it('maps left and right directional aliases to port and starboard', () => {
    expect(service.detectDirectionalSide('left engine oil filter')).toBe(
      'port',
    );
    expect(service.detectDirectionalSide('right engine oil filter')).toBe(
      'starboard',
    );
  });

  it('does not treat temporal or remaining-time phrases as directional sides', () => {
    expect(
      service.detectDirectionalSide('Are any bilge alarms active right now?'),
    ).toBeNull();
    expect(
      service.detectDirectionalSide('How many hours left until service?'),
    ).toBeNull();
  });

  it('skips documentation retrieval for telemetry list requests so manuals do not override live metric samples', () => {
    const query = 'Show 10 random active metrics for this ship.';

    expect(service.isTelemetryListQuery(query)).toBe(true);
    expect(service.shouldSkipDocumentationRetrieval(query)).toBe(true);
  });

  it('skips documentation retrieval for normalized telemetry completeness follow-ups', () => {
    const retrievalQuery = service.buildRetrievalQuery(
      'you missed a lot of bilge alarms, write all',
      'list all available bilge alarm metrics',
    );

    expect(retrievalQuery).toBe(
      'available bilge alarm metrics show all available',
    );
    expect(
      service.shouldPromoteRetrievalQueryToAnswerQuery(
        'you missed a lot of bilge alarms, write all',
        'list all available bilge alarm metrics',
        retrievalQuery,
      ),
    ).toBe(true);
    expect(service.isTelemetryListQuery(retrievalQuery)).toBe(true);
    expect(service.shouldSkipDocumentationRetrieval(retrievalQuery)).toBe(true);
  });

  it('keeps historical continuation rewrites canonical instead of concatenating repeated fragments', () => {
    expect(
      service.buildRetrievalQuery(
        'how many total fuel in tanks 5 days ago?',
        'how many fuel was 5 days ago?',
      ),
    ).toBe('how many total fuel in tanks 5 days ago');

    expect(
      service.buildRetrievalQuery(
        '5 days ago, on 25th of March',
        'how many total fuel in tanks 5 days ago?',
      ),
    ).toBe('how many total fuel in tanks on 2026-03-25');
  });

  it('inherits the previous telemetry subject for vague aggregate follow-up questions', () => {
    expect(
      service.buildRetrievalQuery('what the sum', 'what the fuel level'),
    ).toBe('what the fuel level in the tanks');
    expect(
      service.buildRetrievalQuery(
        'what the total',
        'what was the fuel level 5 days ago',
      ),
    ).toBe('what was the fuel level in the tanks 5 days ago');
  });

  it('does not hijack unrelated sum phrases as telemetry aggregate follow-ups', () => {
    expect(
      service.buildRetrievalQuery(
        'what the sum insured',
        'what the fuel level',
      ),
    ).toBe('what the sum insured');
  });

  it('reconstructs aggregate telemetry follow-up context from prior assistant metadata', () => {
    expect(
      service.getPreviousResolvedUserQuery([
        {
          role: 'user',
          content: 'what was the fuel level 5 days ago',
        },
        {
          role: 'assistant',
          content: 'At 2026-03-31 19:03 UTC, the historical total was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'what was the fuel level 5 days ago',
            normalizedQuery: {
              operation: 'sum',
              timeIntent: {
                kind: 'historical_point',
                relativeAmount: 5,
                relativeUnit: 'day',
              },
            },
          },
        },
      ]),
    ).toBe('how much total fuel level in the tanks 5 days ago');
  });
});
