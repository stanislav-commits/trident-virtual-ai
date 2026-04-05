import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatQueryNormalizationService } from './chat-query-normalization.service';
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
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
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
      ['MANUALS'],
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
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn<
          (
            shipId: string | null,
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => Promise<ChatCitation[]>
        >()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn<
          (
            shipId: string | null,
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => Promise<ChatCitation[]>
        >()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest
        .fn<
          (
            shipId: string | null,
            retrievalQuery: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => Promise<ChatCitation[]>
        >()
        .mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
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
      ['MANUALS'],
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

  it('keeps short contact-detail clarification replies attached to the pending subject', async () => {
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
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

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
        content: 'provide his contacts',
      },
      {
        role: 'assistant',
        content:
          'I need clarification on what specific contacts you are looking for.',
        ragflowContext: {
          awaitingClarification: true,
          pendingClarificationQuery: 'emergency dpa contacts',
        },
      },
      {
        role: 'user',
        content: 'yes, contact details',
      },
    ];

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'yes, contact details',
      messageHistory,
    });

    expect(result.retrievalQuery).toBe('emergency dpa contacts contact details');
    expect(result.answerQuery).toBe(result.retrievalQuery);
    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'emergency dpa contacts contact details',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('promotes analytical temporal follow-ups into answerQuery for downstream reasoning', async () => {
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
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

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
        content: 'calculate how many fuel do i need for the next month?',
      },
      {
        role: 'assistant',
        content:
          'The history is insufficient for a reliable forecast of fuel needs for the next month.',
      },
      {
        role: 'user',
        content: 'based on the last month',
      },
    ];

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'based on the last month',
      messageHistory,
    });

    expect(result.retrievalQuery).toBe(
      'calculate how many fuel do i need for the next month based on the last month',
    );
    expect(result.answerQuery).toBe(result.retrievalQuery);
    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      result.retrievalQuery,
      expect.any(Number),
      expect.any(Number),
      ['HISTORY_PROCEDURES'],
    );
  });

  it('runs a second narrowing pass when an exact maintenance subject is resolved from the first citation set', async () => {
    const citations: ChatCitation[] = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: FUEL PURIFIER Task name: CARTRIDGE AND FILTER ANNUAL MAINTENANCE Reference ID: 1P280 Included work items: - CHANGE THE FILTER AND CARTRIDGE ONCE PER YEAR',
        score: 0.91,
      },
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: FUEL PURIFIER Task name: CLEAN BOWL AND DISCS EVERY 6 MONTHS Reference ID: 1P281 Included work items: - CLEAN BOWL - CLEAN DISCS',
        score: 0.92,
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
        .mockImplementation((query, retrievedCitations) =>
          /reference id 1p280/i.test(query)
            ? [retrievedCitations[0]]
            : retrievedCitations,
        ),
      refineCitationsForIntent: jest
        .fn<
          (
            query: string,
            userQuery: string,
            citations: ChatCitation[],
          ) => ChatCitation[]
        >()
        .mockImplementation((_query, _userQuery, retrievedCitations) => retrievedCitations),
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
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest
        .fn()
        .mockReturnValue(
          'M Y Seawolf X Maintenance Tasks Reference ID 1P280 FUEL PURIFIER CARTRIDGE AND FILTER ANNUAL MAINTENANCE',
        ),
      buildClarificationActions: jest.fn().mockReturnValue([]),
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
      userQuery: 'What does the fuel purifier annual maintenance include?',
    });

    expect(result.resolvedSubjectQuery).toContain('Reference ID 1P280');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].snippet).toContain('Reference ID: 1P280');
    expect(
      (citationService.pruneCitationsForResolvedSubject as jest.Mock).mock.calls.some(
        (call) => /reference id 1p280/i.test(call[0]),
      ),
    ).toBe(true);
    expect(
      (citationService.prepareCitationsForAnswer as jest.Mock).mock.calls[0][0],
    ).toContain('Reference ID 1P280');
  });

  it('runs a second exact-row retrieval and scan pass after resolving a maintenance subject', async () => {
    const resolvedSubjectQuery =
      'M Y Seawolf X Maintenance Tasks Reference ID 1P47 PS ENGINE A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE';
    const initialCitation: ChatCitation = {
      sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
      score: 0.74,
      snippet: `Component name: PS ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1P47`,
    };
    const resolvedCitation: ChatCitation = {
      sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
      score: 0.96,
      snippet: `Reference ID: 1P47
Spare parts:
- Spare Name: Volvo Penta - Impeller Kit
Quantity: 1
Location: BOX 25 VOLVO PENTA SPARES`,
    };

    const contextService = {
      findContextForQuery: jest.fn().mockImplementation((_shipId, query) => {
        if (query === resolvedSubjectQuery) {
          return Promise.resolve({ citations: [resolvedCitation] });
        }

        return Promise.resolve({ citations: [initialCitation] });
      }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    jest
      .spyOn(queryService, 'buildGeneratorAssetFallbackQueries')
      .mockReturnValue([]);
    jest
      .spyOn(queryService, 'buildPartsFallbackQueries')
      .mockReturnValue([]);
    jest
      .spyOn(queryService, 'buildReferenceContinuationFallbackQueries')
      .mockReturnValue([]);

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
        .fn()
        .mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest
        .fn()
        .mockReturnValue(resolvedSubjectQuery),
      buildClarificationActions: jest.fn().mockReturnValue([]),
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
      userQuery: 'Where are the impeller spares for the port generator stored?',
    });

    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      resolvedSubjectQuery,
      expect.any(Number),
      expect.any(Number),
      ['MANUALS'],
    );
    expect(
      (scanService.expandReferenceDocumentChunkCitations as jest.Mock).mock.calls.some(
        (call) => call[1] === resolvedSubjectQuery,
      ),
    ).toBe(true);
    expect(
      (
        scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock
      ).mock.calls.some(
        (call) => call[1] === resolvedSubjectQuery,
      ),
    ).toBe(true);
    expect(result.resolvedSubjectQuery).toBe(resolvedSubjectQuery);
  });

  it('preserves broad certificate analysis citations before later intent narrowing', async () => {
    const initialCitations: ChatCitation[] = [
      {
        sourceTitle: 'FA170_OME44900J.pdf',
        sourceCategory: 'MANUALS',
        snippet:
          'bearing to a target are updated. However, target order is not updated.',
        score: 0.91,
      },
    ];
    const certificateScanCitations: ChatCitation[] = [
      {
        sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet: 'This Licence expires on: 15 January 2027.',
        score: 0.84,
      },
      {
        sourceTitle: 'JMS Crew MLC Certificate Feb 2023.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet: 'This certificate is valid until 03 February 2028.',
        score: 0.8,
      },
    ];
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: initialCitations }),
      findContextForAdminQuery: jest.fn().mockResolvedValue(initialCitations),
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
        .mockImplementation((_query, _userQuery, citations) => [citations[0]]),
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
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue(certificateScanCitations),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
    );

    const result = await service.prepareDocumentationContext({
      shipId: null,
      role: 'admin',
      userQuery: 'Show me the nearest upcoming certificate expiries',
    });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].sourceTitle).toBe('FA170_OME44900J.pdf');
    expect(result.analysisCitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
        }),
        expect.objectContaining({
          sourceTitle: 'JMS Crew MLC Certificate Feb 2023.pdf',
        }),
      ]),
    );
  });

  it('merges structured personnel-directory scan citations for broad contact-sheet queries', async () => {
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
      prepareCitationsForAnswer: jest.fn().mockImplementation(
        (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
        }),
      ),
      limitCitationsForLlm: jest
        .fn()
        .mockImplementation((_userQuery, citations) => citations),
    } as unknown as ChatDocumentationCitationService;
    const scanCitation: ChatCitation = {
      sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
      snippet:
        'Rob Pijper - Palma Operations Director (M) +31 636 219 315 rob@jmsyachting.com',
      score: 1,
    };
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([scanCitation]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
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
      userQuery: 'list all managers with their contact details',
    });

    expect(
      (
        scanService.expandPersonnelDirectoryDocumentChunkCitations as jest.Mock
      ).mock.calls[0],
    ).toEqual([
      'ship-1',
      'manager contact details',
      'list all managers with their contact details',
      [],
    ]);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        }),
      ]),
    );
  });

  it('merges structured tank-capacity scan citations for tank table lookups', async () => {
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
      prepareCitationsForAnswer: jest.fn().mockImplementation(
        (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
        }),
      ),
      limitCitationsForLlm: jest
        .fn()
        .mockImplementation((_userQuery, citations) => citations),
    } as unknown as ChatDocumentationCitationService;
    const tankCitation: ChatCitation = {
      sourceTitle: 'Fuel Tank Sounding Table.pdf',
      snippet:
        'Fuel Tank 1P capacity 3,142 liters Fuel Tank 2S capacity 2,381 liters',
      score: 1,
    };
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([tankCitation]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
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
      userQuery: 'show tank capacities for fuel tanks',
    });

    expect(
      (scanService.expandTankCapacityDocumentChunkCitations as jest.Mock).mock
        .calls[0],
    ).toEqual([
      'ship-1',
      'show tank capacities for fuel tanks',
      'show tank capacities for fuel tanks',
      [],
      ['MANUALS'],
    ]);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Fuel Tank Sounding Table.pdf',
        }),
      ]),
    );
  });

  it('passes history-procedure restrictions into scan fallbacks for last-maintenance queries', async () => {
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
      prepareCitationsForAnswer: jest.fn().mockImplementation(
        (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
        }),
      ),
      limitCitationsForLlm: jest
        .fn()
        .mockImplementation((_userQuery, citations) => citations),
    } as unknown as ChatDocumentationCitationService;
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
    );

    await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'when was the last separator overhaul?',
    });

    expect(
      (scanService.expandReferenceDocumentChunkCitations as jest.Mock).mock
        .calls[0],
    ).toEqual([
      'ship-1',
      'when was the last separator overhaul?',
      'when was the last separator overhaul?',
      [],
      ['HISTORY_PROCEDURES'],
    ]);
    expect(
      (
        scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock
      ).mock.calls[0],
    ).toEqual([
      'ship-1',
      'when was the last separator overhaul?',
      'when was the last separator overhaul?',
      [],
      ['HISTORY_PROCEDURES'],
    ]);
  });

  it('skips documentation retrieval entirely for telemetry-first current status queries', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: [] }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const normalizationService = new ChatQueryNormalizationService();
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
      prepareCitationsForAnswer: jest.fn().mockImplementation(
        (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
        }),
      ),
      limitCitationsForLlm: jest
        .fn()
        .mockImplementation((_userQuery, citations) => citations),
    } as unknown as ChatDocumentationCitationService;
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandCertificateExpiryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandPersonnelDirectoryDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandTankCapacityDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandAuditChecklistDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
    } as unknown as ChatDocumentationScanService;
    const referenceExtractionService = {
      buildResolvedMaintenanceSubjectQuery: jest.fn().mockReturnValue(null),
      buildClarificationActions: jest.fn().mockReturnValue([]),
    } as unknown as ChatReferenceExtractionService;

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
    );

    const normalizedQuery = normalizationService.normalizeTurn({
      userQuery: 'Are any bilge alarms active right now?',
    });

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'Are any bilge alarms active right now?',
      normalizedQuery,
    });

    expect(result.citations).toEqual([]);
    expect(result.analysisCitations).toEqual([]);
    expect(contextService.findContextForQuery).not.toHaveBeenCalled();
    expect(scanService.expandReferenceDocumentChunkCitations).not.toHaveBeenCalled();
    expect(
      scanService.expandMaintenanceAssetDocumentChunkCitations,
    ).not.toHaveBeenCalled();
  });
});
