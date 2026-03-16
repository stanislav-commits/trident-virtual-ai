import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import { ChatCitation } from './chat.types';

describe('ChatDocumentationService', () => {
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
