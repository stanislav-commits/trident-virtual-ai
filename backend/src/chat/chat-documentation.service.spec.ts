import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import { ChatCitation } from './chat.types';

describe('ChatDocumentationService', () => {
  it('attaches clarification suggestion actions for underspecified queries', async () => {
    const citations: ChatCitation[] = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        score: 0.92,
        snippet: `Component name: PS ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1P47`,
      },
    ];
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = {
      mergeCitations: jest
        .fn<(left: ChatCitation[], right: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((left, right) => [...left, ...right]),
      pruneCitationsForResolvedSubject: jest
        .fn<(query: string, citations: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((_query, retrievedCitations) => retrievedCitations),
      refineCitationsForIntent: jest
        .fn<
          (
            query: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => ChatCitation[]
        >()
        .mockImplementation(
          (_query, _userQuery, retrievedCitations) => retrievedCitations,
        ),
      focusCitationsForQuery: jest
        .fn<(query: string, citations: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((_query, retrievedCitations) => retrievedCitations),
      prepareCitationsForAnswer: jest
        .fn<
          (
            query: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => {
            citations: ChatCitation[];
            compareBySource: boolean;
            sourceComparisonTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, retrievedCitations) => ({
          citations: retrievedCitations,
          compareBySource: false,
          sourceComparisonTitles: [],
        })),
      limitCitationsForLlm: jest
        .fn<
          (
            userQuery: string,
            citations: ChatCitation[],
            compareBySource: boolean,
          ) => ChatCitation[]
        >()
        .mockImplementation((_userQuery, retrievedCitations) => retrievedCitations),
    } as unknown as ChatDocumentationCitationService;
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const clarificationActions = [
      {
        label: 'A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE (1P47)',
        message:
          'How do I change oil for PS ENGINE, A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE, Reference ID 1P47',
        kind: 'suggestion' as const,
      },
      {
        label: 'All',
        message:
          'Please answer all of the following related to "How do I change oil":\n1. How do I change oil for PS ENGINE, A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE, Reference ID 1P47',
        kind: 'all' as const,
      },
    ];
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue(clarificationActions),
    } as unknown as ChatReferenceExtractionService;

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'How do I change oil?',
    });

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestion).toContain(
      'Which exact component or system is this fluid-related request for?',
    );
    expect(result.pendingClarificationQuery).toBe('How do I change oil?');
    expect(result.clarificationActions).toEqual(clarificationActions);
    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'How do I change oil?',
      expect.any(Number),
      expect.any(Number),
    );
    expect(
      (
        referenceExtractionService.buildClarificationActions as jest.Mock
      ).mock.calls[0],
    ).toEqual(['How do I change oil?', citations]);
  });

  it('uses the clarification-resolved query for downstream intent-aware retrieval decisions', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: [] }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = {
      mergeCitations: jest
        .fn<(left: ChatCitation[], right: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((left, right) => [...left, ...right]),
      pruneCitationsForResolvedSubject: jest
        .fn<(query: string, citations: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((_query, citations) => citations),
      refineCitationsForIntent: jest
        .fn<
          (
            query: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => ChatCitation[]
        >()
        .mockImplementation((_query, _userQuery, citations) => citations),
      focusCitationsForQuery: jest
        .fn<(query: string, citations: ChatCitation[]) => ChatCitation[]>()
        .mockImplementation((_query, citations) => citations),
      prepareCitationsForAnswer: jest
        .fn<
          (
            query: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => {
            citations: ChatCitation[];
            compareBySource: boolean;
            sourceComparisonTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
        })),
      limitCitationsForLlm: jest
        .fn<
          (
            userQuery: string,
            citations: ChatCitation[],
            compareBySource: boolean,
          ) => ChatCitation[]
        >()
        .mockImplementation((_userQuery, citations) => citations),
    } as unknown as ChatDocumentationCitationService;
    const scanService = {
      expandReferenceDocumentChunkCitations: jest
        .fn<
          (
            shipId: string | null,
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => Promise<ChatCitation[]>
        >()
        .mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn<
          (
            shipId: string | null,
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => Promise<ChatCitation[]>
        >()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest
        .fn<
          (
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => string | null
        >()
        .mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

    const augmentSpy = jest.spyOn(
      queryService,
      'shouldAugmentGeneratorAssetLookup',
    );
    const partsSpy = jest.spyOn(queryService, 'isPartsQuery');
    const fallbackSpy = jest.spyOn(queryService, 'buildPartsFallbackQueries');

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
    );

    const messageHistory = [
      {
        role: 'user',
        content: 'How do I change oil?',
      },
      {
        role: 'assistant',
        content:
          'Which exact component or system is this fluid-related request for?',
        ragflowContext: {
          awaitingClarification: true,
          pendingClarificationQuery: 'How do I change oil?',
        },
      },
      {
        role: 'user',
        content: 'in the port generator',
      },
    ];

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'in the port generator',
      messageHistory,
    });

    expect(result.retrievalQuery).toBe('How do I change oil in the port generator');
    expect(augmentSpy).toHaveBeenCalledWith(
      'How do I change oil in the port generator',
      'How do I change oil in the port generator',
    );
    expect(partsSpy).toHaveBeenCalledWith(
      'How do I change oil in the port generator',
    );
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(
      (
        scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock
      ).mock.calls[0],
    ).toEqual([
      'ship-1',
      'How do I change oil in the port generator',
      'How do I change oil in the port generator',
      [],
    ]);
    expect(
      (
        citationService.prepareCitationsForAnswer as jest.Mock
      ).mock.calls[0][1],
    ).toBe('How do I change oil in the port generator');
    expect(
      (citationService.limitCitationsForLlm as jest.Mock).mock.calls[0][0],
    ).toBe('How do I change oil in the port generator');
    expect(
      (
        referenceExtractionService.buildResolvedMaintenanceSubjectQuery as jest.Mock
      ).mock.calls[0][1],
    ).toBe('How do I change oil in the port generator');
  });
});
