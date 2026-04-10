import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatQueryNormalizationService } from './chat-query-normalization.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import { ChatCitation } from './chat.types';

describe('ChatDocumentationService', () => {
  it('does not ask which semantic source to use when top document candidates are tied', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      {} as never,
    );

    const clarification = (service as any).buildSemanticSourceClarification({
      userQuery:
        'How should I acknowledge an engine alarm and find the corrective action?',
      retrievalQuery:
        'How should I acknowledge an engine alarm and find the corrective action?',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'manual_lookup',
        conceptFamily: 'maintenance_topic',
        selectedConceptIds: ['troubleshooting_guide'],
        candidateConceptIds: ['troubleshooting_guide'],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.82,
      },
      semanticCandidates: [
        {
          manualId: 'manual-volvo',
          documentId: 'doc-volvo',
          filename: 'Volvo Penta_operators manual_47710211.pdf',
          category: 'MANUALS',
          score: 122,
          reasons: ['profile_text'],
        },
        {
          manualId: 'manual-mase',
          documentId: 'doc-mase',
          filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
          category: 'MANUALS',
          score: 118,
          reasons: ['profile_text'],
        },
      ],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
      followUpState: null,
    });

    expect(clarification).toBeNull();
  });

  it('keeps only the top two strong semantic manual candidates for retrieval scope', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      {} as never,
    );

    const selectedManualIds = (service as any).selectSemanticManualIds(
      [
        {
          manualId: 'manual-primary',
          documentId: 'doc-primary',
          filename: 'Primary Manual.pdf',
          category: 'MANUALS',
          score: 130,
          reasons: ['profile_text'],
        },
        {
          manualId: 'manual-secondary',
          documentId: 'doc-secondary',
          filename: 'Secondary Manual.pdf',
          category: 'MANUALS',
          score: 124,
          reasons: ['profile_text'],
        },
        {
          manualId: 'manual-third',
          documentId: 'doc-third',
          filename: 'Third Manual.pdf',
          category: 'MANUALS',
          score: 120,
          reasons: ['profile_text'],
        },
      ],
      {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'manual_lookup',
        conceptFamily: 'maintenance_topic',
        selectedConceptIds: [],
        candidateConceptIds: [],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.82,
      },
    );

    expect(selectedManualIds).toEqual(['manual-primary', 'manual-secondary']);
  });

  it('does not ask for semantic source clarification when the top candidate has stronger direct source-match evidence', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      {} as never,
    );

    const clarification = (service as any).buildSemanticSourceClarification({
      userQuery: 'list all 500-hour maintenance items for the diesel generator',
      retrievalQuery:
        'list all 500-hour maintenance items for the diesel generator',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'maintenance_procedure',
        conceptFamily: 'asset_system',
        selectedConceptIds: [],
        candidateConceptIds: [],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.72,
      },
      semanticCandidates: [
        {
          manualId: 'manual-mase',
          documentId: 'doc-mase',
          filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
          category: 'MANUALS',
          score: 203,
          reasons: ['filename_overlap', 'query_anchor', 'profile_text'],
        },
        {
          manualId: 'manual-common',
          documentId: 'doc-common',
          filename: 'Common Maintenance and Procedure Tasks.pdf',
          category: 'MANUALS',
          score: 203,
          reasons: ['manual_tag_text', 'profile_text'],
        },
      ],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
      followUpState: null,
    });

    expect(clarification).toBeNull();
  });

  it('does not ask for semantic source clarification when the top candidate has stronger structured asset overlap', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      {} as never,
    );

    const clarification = (service as any).buildSemanticSourceClarification({
      userQuery: 'what is included in the 500-hour diesel generator maintenance?',
      retrievalQuery:
        'what is included in the 500-hour diesel generator maintenance?',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'maintenance_procedure',
        conceptFamily: 'maintenance_topic',
        selectedConceptIds: [],
        candidateConceptIds: ['maintenance_checklist'],
        equipment: ['diesel generator'],
        systems: ['electrical'],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
        explicitSource: null,
        pageHint: null,
        sectionHint: '500-hour maintenance',
        answerFormat: 'checklist',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.73,
      },
      semanticCandidates: [
        {
          manualId: 'manual-mase',
          documentId: 'doc-mase',
          filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
          category: 'MANUALS',
          score: 211,
          reasons: ['equipment_overlap', 'system_overlap', 'profile_text'],
        },
        {
          manualId: 'manual-common',
          documentId: 'doc-common',
          filename: 'Common Maintenance and Procedure Tasks.pdf',
          category: 'MANUALS',
          score: 203,
          reasons: ['manual_tag_text', 'profile_text'],
        },
      ],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
      followUpState: null,
    });

    expect(clarification).toBeNull();
  });

  it('does not ask for semantic source clarification for interval-maintenance queries when one candidate clearly leads', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      {} as never,
    );

    const clarification = (service as any).buildSemanticSourceClarification({
      userQuery: 'what maintenance is listed as needed for the diesel generator?',
      retrievalQuery:
        'what maintenance is listed as needed for the diesel generator?',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'maintenance_procedure',
        conceptFamily: 'maintenance_topic',
        selectedConceptIds: ['maintenance_checklist'],
        candidateConceptIds: ['maintenance_checklist'],
        equipment: ['diesel generator'],
        systems: ['engine'],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: 'maintenance as needed',
        answerFormat: 'checklist',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.74,
      },
      semanticCandidates: [
        {
          manualId: 'manual-mase',
          documentId: 'doc-mase',
          filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
          category: 'MANUALS',
          score: 220,
          reasons: ['equipment_overlap', 'profile_text'],
        },
        {
          manualId: 'manual-common',
          documentId: 'doc-common',
          filename: 'Common Maintenance Tasks.pdf',
          category: 'MANUALS',
          score: 202,
          reasons: ['manual_tag_text', 'profile_text'],
        },
      ],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
      followUpState: null,
    });

    expect(clarification).toBeNull();
  });

  it('filters final citations back to the semantic manual scope before follow-up state is built', async () => {
    const goodCitation: ChatCitation = {
      shipManualId: 'manual-macb',
      chunkId: 'chunk-macb',
      pageNumber: 12,
      sourceTitle: 'MN_MACB531.pdf',
      sourceCategory: 'MANUALS',
      snippet: 'Replace the fuel filter and bleed the pump before restart.',
      score: 0.93,
    };
    const leakedCitation: ChatCitation = {
      shipManualId: 'manual-ballast',
      chunkId: 'chunk-ballast',
      pageNumber: 4,
      sourceTitle: 'EXAMPLE BALLAST MNGT PLAN.pdf',
      sourceCategory: 'MANUALS',
      snippet: 'Ballast water exchange example procedure.',
      score: 0.88,
    };
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({
        citations: [goodCitation, leakedCitation],
      }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure' as const,
      conceptFamily: 'asset_system' as const,
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: ['emergency bilge pump'],
      systems: ['fuel system'],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS' as const],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'fuel filter replacement',
      answerFormat: 'step_by_step' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.87,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-macb',
          documentId: 'doc-macb',
          filename: 'MN_MACB531.pdf',
          category: 'MANUALS',
          score: 214,
          reasons: ['profile_text', 'equipment_overlap'],
        },
      ]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };
    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      undefined,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'How do I replace the fuel filter on the emergency bilge pump?',
    });

    expect(result.citations).toEqual([goodCitation]);
    expect(result.analysisCitations).toEqual([goodCitation]);
    expect(sourceLockService.buildNextFollowUpState).toHaveBeenCalledWith(
      expect.objectContaining({
        citations: [goodCitation],
      }),
    );
  });

  it('prioritizes locked page-aware citations and searches with the current follow-up text', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({
        citations: [
          {
            shipManualId: 'manual-volvo',
            chunkId: 'ragflow:p17',
            pageNumber: 17,
            sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
            sourceCategory: 'MANUALS',
            snippet:
              'Introduction. Check that you have received the correct operator manual.',
            score: 0.9,
          },
        ],
      }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'manual_lookup' as const,
      conceptFamily: 'asset_system' as const,
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS' as const],
      explicitSource: null,
      pageHint: 121,
      sectionHint: 'emergency steering',
      answerFormat: 'direct_answer' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.95,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-volvo',
          documentId: 'doc-volvo',
          filename: 'Volvo Penta_operators manual_47710211.pdf',
          category: 'MANUALS',
          score: 140,
          reasons: ['profile_text'],
        },
      ]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue({
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'manual_lookup',
        conceptIds: [],
        sourcePreferences: ['MANUALS'],
        sourceLock: true,
        lockedManualId: 'manual-volvo',
        lockedManualTitle: 'Volvo Penta_operators manual_47710211.pdf',
        lockedDocumentId: 'doc-volvo',
        pageHint: null,
        sectionHint: 'emergency steering',
        vendor: null,
        model: null,
        systems: [],
        equipment: [],
      }),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: true,
        lockedManualId: 'manual-volvo',
        lockedManualTitle: 'Volvo Penta_operators manual_47710211.pdf',
        lockedDocumentId: 'doc-volvo',
        reason: 'page_or_section_follow_up',
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };
    const pageAwareRetriever = {
      retrieveLockedManualPage: jest.fn().mockResolvedValue([
        {
          shipManualId: 'manual-volvo',
          chunkId: 'page-aware:manual-volvo:chunk-121',
          pageNumber: 121,
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          sourceCategory: 'MANUALS',
          snippet:
            'Emergency Steering. Align the Electrical Rudder Actuator and use the control levers to reach the nearest harbor.',
          score: 20,
        },
      ]),
    };
    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      undefined,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
      pageAwareRetriever as never,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'What does page 121 say in this manual?',
      normalizedQuery: {
        rawQuery: 'What does page 121 say in this manual?',
        normalizedQuery:
          'volvo penta operators manual emergency steering what does page 121 say in this manual?',
        retrievalQuery:
          'volvo penta operators manual emergency steering What does page 121 say in this manual?',
        effectiveQuery:
          'volvo penta operators manual emergency steering What does page 121 say in this manual?',
        previousUserQuery:
          'From Volvo Penta_operators manual_47710211.pdf document: What should I do if emergency steering is needed?',
        followUpMode: 'follow_up',
        subject: 'volvo penta emergency steering',
        operation: 'lookup',
        timeIntent: { kind: 'none' },
        sourceHints: ['DOCUMENTATION'],
        isClarificationReply: false,
        ambiguityFlags: [],
      },
    });

    expect(pageAwareRetriever.retrieveLockedManualPage).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalQuery: 'What does page 121 say in this manual?',
        pageHint: 121,
      }),
    );
    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'What does page 121 say in this manual?',
      expect.any(Number),
      expect.any(Number),
      ['MANUALS'],
      ['manual-volvo'],
    );
    expect(result.retrievalQuery).toBe(
      'What does page 121 say in this manual?',
    );
    expect(result.citations).toEqual([
      expect.objectContaining({
        chunkId: 'page-aware:manual-volvo:chunk-121',
        pageNumber: 121,
      }),
    ]);
  });

  it('keeps regulation-category procedure documents in scope for operational semantic queries', async () => {
    const citations: ChatCitation[] = [
      {
        shipManualId: 'manual-enclosed',
        chunkId: 'chunk-entry',
        pageNumber: 3,
        sourceTitle: 'Safety procedure.pdf',
        sourceCategory: 'REGULATION',
        snippet:
          'Before entering an enclosed space, complete the permit, test the atmosphere, ventilate, and assign a standby watch.',
        score: 0.92,
      },
    ];
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'operational_procedure' as const,
      conceptFamily: 'operational_topic' as const,
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: [],
      systems: ['enclosed space safety'],
      vendor: null,
      model: null,
      sourcePreferences: ['HISTORY_PROCEDURES' as const, 'MANUALS' as const],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'checklist' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.86,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-enclosed',
          documentId: 'doc-enclosed',
          filename: 'Safety procedure.pdf',
          category: 'REGULATION',
          score: 76,
          reasons: ['profile_text'],
        },
      ]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };
    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      undefined,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery:
        'What is the safe procedure for entering an enclosed space?',
    });

    expect(semanticMatcher.shortlistManuals).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDocumentCategories: expect.arrayContaining([
          'HISTORY_PROCEDURES',
          'MANUALS',
          'REGULATION',
        ]),
      }),
    );
    expect(contextService.findContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'What is the safe procedure for entering an enclosed space?',
      expect.any(Number),
      expect.any(Number),
      expect.arrayContaining([
        'HISTORY_PROCEDURES',
        'MANUALS',
        'REGULATION',
      ]),
      ['manual-enclosed'],
    );
    expect(result.citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'Safety procedure.pdf',
        sourceCategory: 'REGULATION',
      }),
    ]);
  });

  it('backfills missing shortlisted manual evidence so top-two procedure sources can merge', async () => {
    const primaryCitations: ChatCitation[] = [
      {
        shipManualId: 'manual-primary',
        chunkId: 'chunk-primary-1',
        pageNumber: 1,
        sourceTitle: 'Procedures - Bunkering and Transfers (3).pdf',
        sourceCategory: 'HISTORY_PROCEDURES',
        snippet:
          'Before bunkering, inform the Deck Officer and Captain, agree the tank filling sequence, and establish clear communications.',
        score: 0.92,
      },
      {
        shipManualId: 'manual-primary',
        chunkId: 'chunk-primary-2',
        pageNumber: 2,
        sourceTitle: 'Procedures - Bunkering and Transfers (3).pdf',
        sourceCategory: 'HISTORY_PROCEDURES',
        snippet:
          'Bunkering 1. Begin bunkering after ensuring all parties are ready and in their designated position. 2. Check the flow rate with the pump operator.',
        score: 0.89,
      },
    ];
    const secondaryCitations: ChatCitation[] = [
      {
        shipManualId: 'manual-secondary',
        chunkId: 'chunk-secondary-1',
        pageNumber: 1,
        sourceTitle: 'SOP 12.31 Bunkering v2.pdf',
        sourceCategory: 'REGULATION',
        snippet:
          'Bunkering checklist: verify scuppers plugged, spill equipment ready, communications established, and manifold drip trays in place.',
        score: 0.88,
      },
      {
        shipManualId: 'manual-secondary',
        chunkId: 'chunk-secondary-2',
        pageNumber: 2,
        sourceTitle: 'SOP 12.31 Bunkering v2.pdf',
        sourceCategory: 'REGULATION',
        snippet:
          'Stop points during bunkering shall be agreed in advance; complete the bunker checklist before starting transfers.',
        score: 0.86,
      },
    ];
    const contextService = {
      findContextForQuery: jest
        .fn()
        .mockImplementation(
          async (
            _shipId: string,
            _query: string,
            _topK: number,
            _candidateK: number,
            _allowedDocumentCategories?: string[],
            allowedManualIds?: string[],
          ) => {
            if (
              allowedManualIds?.length === 2 &&
              allowedManualIds.includes('manual-primary') &&
              allowedManualIds.includes('manual-secondary')
            ) {
              return { citations: primaryCitations };
            }

            if (
              allowedManualIds?.length === 1 &&
              allowedManualIds[0] === 'manual-secondary'
            ) {
              return { citations: secondaryCitations };
            }

            return { citations: [] };
          },
        ),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'operational_procedure' as const,
      conceptFamily: 'operational_topic' as const,
      selectedConceptIds: ['bunkering_operation'],
      candidateConceptIds: ['bunkering_operation'],
      equipment: [],
      systems: ['fuel_system'],
      vendor: null,
      model: null,
      sourcePreferences: [
        'HISTORY_PROCEDURES' as const,
        'REGULATION' as const,
        'MANUALS' as const,
      ],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'step_by_step' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.98,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-primary',
          documentId: 'doc-primary',
          filename: 'Procedures - Bunkering and Transfers (3).pdf',
          category: 'HISTORY_PROCEDURES',
          score: 188,
          reasons: ['profile_text'],
        },
        {
          manualId: 'manual-secondary',
          documentId: 'doc-secondary',
          filename: 'SOP 12.31 Bunkering v2.pdf',
          category: 'REGULATION',
          score: 158,
          reasons: ['profile_text'],
        },
      ]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };
    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      undefined,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'i will have bunkering soon, describe me step by step procedure',
    });

    expect(
      contextService.findContextForQuery.mock.calls.some(
        (call) =>
          Array.isArray(call[5]) &&
          call[5].length === 1 &&
          call[5][0] === 'manual-secondary',
      ),
    ).toBe(true);
    expect(result.mergeBySource).toBe(true);
    expect(result.sourceMergeTitles).toEqual([
      'Procedures - Bunkering and Transfers (3).pdf',
      'SOP 12.31 Bunkering v2.pdf',
    ]);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Procedures - Bunkering and Transfers (3).pdf',
        }),
        expect.objectContaining({
          sourceTitle: 'SOP 12.31 Bunkering v2.pdf',
        }),
      ]),
    );
  });

  it('does not duplicate the matcher query text when retrieval and user queries are the same', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: [] }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'manual_lookup' as const,
      conceptFamily: 'asset_system' as const,
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: ['MF/HF radio', 'control unit', 'antenna coupler'],
      systems: ['radio communication system'],
      vendor: null,
      model: null,
      sourcePreferences: [
        'MANUALS' as const,
        'HISTORY_PROCEDURES' as const,
        'REGULATION' as const,
      ],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'installation',
      answerFormat: 'step_by_step' as const,
      needsClarification: true,
      clarificationReason: 'semantic_low_confidence',
      confidence: 0.31,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-ssb',
          documentId: 'doc-ssb',
          filename: 'FS1575_2575_5075_IME56770R2.pdf',
          category: 'MANUALS',
          score: 256,
          reasons: ['query_anchor', 'equipment_overlap'],
        },
      ]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };
    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      undefined,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
    );

    const userQuery =
      'How do I install the control unit and antenna coupler for the MF/HF radio?';
    await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery,
    });

    expect(semanticMatcher.shortlistManuals).toHaveBeenCalledWith(
      expect.objectContaining({
        queryText: userQuery,
      }),
    );
  });

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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, retrievedCitations) => ({
          citations: retrievedCitations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
        })),
      limitCitationsForLlm: jest
        .fn<
          (
            userQuery: string,
            citations: ChatCitation[],
            compareBySource: boolean,
          ) => ChatCitation[]
        >()
        .mockImplementation(
          (_userQuery, retrievedCitations) => retrievedCitations,
        ),
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
      buildClarificationActions: jest
        .fn()
        .mockReturnValue(clarificationActions),
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
      (referenceExtractionService.buildClarificationActions as jest.Mock).mock
        .calls[0],
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
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

    expect(result.retrievalQuery).toBe(
      'How do I change oil in the port generator',
    );
    expect(augmentSpy).toHaveBeenCalledWith(
      'How do I change oil in the port generator',
      'How do I change oil in the port generator',
    );
    expect(partsSpy).toHaveBeenCalledWith(
      'How do I change oil in the port generator',
    );
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(
      (scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock)
        .mock.calls[0],
    ).toEqual([
      'ship-1',
      'How do I change oil in the port generator',
      'How do I change oil in the port generator',
      [],
      ['MANUALS'],
    ]);
    expect(
      (citationService.prepareCitationsForAnswer as jest.Mock).mock.calls[0][1],
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
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

    expect(result.retrievalQuery).toBe(
      'emergency dpa contacts contact details',
    );
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
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
      undefined,
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, retrievedCitations) => ({
          citations: retrievedCitations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
        })),
      limitCitationsForLlm: jest
        .fn<
          (
            userQuery: string,
            citations: ChatCitation[],
            compareBySource: boolean,
          ) => ChatCitation[]
        >()
        .mockImplementation(
          (_userQuery, retrievedCitations) => retrievedCitations,
        ),
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
      (
        citationService.pruneCitationsForResolvedSubject as jest.Mock
      ).mock.calls.some((call) => /reference id 1p280/i.test(call[0])),
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
    jest.spyOn(queryService, 'buildPartsFallbackQueries').mockReturnValue([]);
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
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
      undefined,
    );
    expect(
      (
        scanService.expandReferenceDocumentChunkCitations as jest.Mock
      ).mock.calls.some((call) => call[1] === resolvedSubjectQuery),
    ).toBe(true);
    expect(
      (
        scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock
      ).mock.calls.some((call) => call[1] === resolvedSubjectQuery),
    ).toBe(true);
    expect(result.resolvedSubjectQuery).toBe(resolvedSubjectQuery);
  });

  it('preserves the exact starboard maintenance row during second-pass narrowing when fallback citations include a preceding foreign row', async () => {
    const initialRetrievalQuery =
      'What are the starboard generator running hours right now? should i perform any maintenance at this counter?';
    const resolvedSubjectQuery =
      'M Y Seawolf X Maintenance Tasks Reference ID 1S47 SB ENGINE A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE';
    const initialCitation: ChatCitation = {
      sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
      score: 0.91,
      snippet: `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1P47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2026 / 2034</td><td>EUR</td></tr>
<tr><td>0212 ENGINES</td><td>SB ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1S47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET SB</td><td>07.07.2025 / 1750</td><td>07.07.2026 / 2250</td><td>EUR</td></tr>
</table>`,
    };
    const resolvedCitation: ChatCitation = {
      sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
      score: 0.96,
      snippet: `Reference row:
Component name: PS ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1P47
Interval: 1 Years / 500 MAIN GENSET PS
Next due: 07.07.2026 / 2034

Reference row:
Component name: SB ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1S47
Interval: 1 Years / 500 MAIN GENSET SB
Next due: 07.07.2026 / 2250`,
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
    jest.spyOn(queryService, 'buildPartsFallbackQueries').mockReturnValue([]);
    jest
      .spyOn(queryService, 'buildReferenceContinuationFallbackQueries')
      .mockReturnValue([]);

    const citationService = new ChatDocumentationCitationService(queryService);
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([]),
      expandManualIntervalMaintenanceChunkCitations: jest
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
    const referenceExtractionService = new ChatReferenceExtractionService(
      queryService,
    );

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
      userQuery: 'should i perform any maintenance at this counter?',
      normalizedQuery: {
        rawQuery: 'should i perform any maintenance at this counter?',
        normalizedQuery: initialRetrievalQuery.toLowerCase(),
        followUpMode: 'follow_up',
        previousUserQuery: 'What are the starboard generator running hours right now?',
        retrievalQuery: initialRetrievalQuery,
        effectiveQuery: initialRetrievalQuery,
        subject: 'starboard generator maintenance counter follow-up',
        operation: 'lookup',
        timeIntent: { kind: 'none' },
        sourceHints: ['TELEMETRY', 'DOCUMENTATION'],
        isClarificationReply: false,
        ambiguityFlags: [],
      } as any,
    });

    expect(result.resolvedSubjectQuery).toContain('Reference ID 1S47');
    expect(result.resolvedSubjectQuery).toContain('SB ENGINE');
    expect(result.resolvedSubjectQuery).not.toContain('Reference ID 1P47');
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          snippet: expect.stringContaining('1S47'),
        }),
      ]),
    );
    expect(
      result.citations.some((citation) =>
        /Reference ID:\s*1P47/i.test(citation.snippet ?? ''),
      ),
    ).toBe(false);
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
      findContextForQuery: jest
        .fn()
        .mockResolvedValue({ citations: initialCitations }),
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
            mergeBySource: boolean;
            sourceMergeTitles: string[];
          }
        >()
        .mockImplementation((_query, _userQuery, citations) => ({
          citations,
          compareBySource: false,
          sourceComparisonTitles: [],
          mergeBySource: false,
          sourceMergeTitles: [],
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
      (scanService.expandPersonnelDirectoryDocumentChunkCitations as jest.Mock)
        .mock.calls[0],
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
      (scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock)
        .mock.calls[0],
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
    expect(
      scanService.expandReferenceDocumentChunkCitations,
    ).not.toHaveBeenCalled();
    expect(
      scanService.expandMaintenanceAssetDocumentChunkCitations,
    ).not.toHaveBeenCalled();
  });

  it('skips documentation retrieval entirely for telemetry-first onboard inventory queries', async () => {
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
      userQuery: 'How many fresh water onboard right now?',
    });

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'How many fresh water onboard right now?',
      normalizedQuery,
    });

    expect(result.citations).toEqual([]);
    expect(result.analysisCitations).toEqual([]);
    expect(contextService.findContextForQuery).not.toHaveBeenCalled();
    expect(
      scanService.expandReferenceDocumentChunkCitations,
    ).not.toHaveBeenCalled();
  });

  it('skips documentation retrieval entirely for telemetry-first historical position queries', async () => {
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
      prepareCitationsForAnswer: jest
        .fn()
        .mockImplementation(
          (_query: string, _userQuery: string, citations: ChatCitation[]) => ({
            citations,
            compareBySource: false,
            sourceComparisonTitles: [],
            mergeBySource: false,
            sourceMergeTitles: [],
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
      userQuery: 'What was the yacht position on 15 March 2026 at 10:00?',
    });

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'What was the yacht position on 15 March 2026 at 10:00?',
      normalizedQuery,
    });

    expect(result.citations).toEqual([]);
    expect(result.analysisCitations).toEqual([]);
    expect(contextService.findContextForQuery).not.toHaveBeenCalled();
    expect(
      scanService.expandReferenceDocumentChunkCitations,
    ).not.toHaveBeenCalled();
    expect(
      scanService.expandMaintenanceAssetDocumentChunkCitations,
    ).not.toHaveBeenCalled();
  });

  it('keeps documentation clarification selections out of telemetry-first skip logic', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );
    const normalizedQuery = {
      sourceHints: ['TELEMETRY'],
      clarificationState: {
        clarificationDomain: 'documentation',
        pendingQuery: 'How should lithium batteries be handled safely onboard?',
      },
    };

    expect(
      (service as any).shouldSkipDocumentationForTelemetryFirstQuery(
        'From Safety Circular.pdf document: How should lithium batteries be handled safely onboard?',
        'From Safety Circular.pdf document: How should lithium batteries be handled safely onboard?',
        normalizedQuery,
      ),
    ).toBe(false);
  });

  it('does not skip documentation retrieval for natural-language parts questions', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );
    const normalizedQuery = new ChatQueryNormalizationService().normalizeTurn({
      userQuery:
        'Which kit contains the O-rings and lip seals for the waterjet?',
    });

    expect(
      (service as any).shouldSkipDocumentationForTelemetryFirstQuery(
        'Which kit contains the O-rings and lip seals for the waterjet?',
        'Which kit contains the O-rings and lip seals for the waterjet?',
        normalizedQuery,
      ),
    ).toBe(false);
  });

  it('does not category-filter explicit source selections by guessed source preferences', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveDocumentCategories(
        {
          explicitSource: 'Fleet Circular Cable reels rev. 1.pdf',
          sourcePreferences: ['MANUALS'],
          intent: 'general_information',
        },
        ['MANUALS'],
      ),
    ).toBeUndefined();
  });

  it('uses the clean selected-source question for explicit source-locked retrieval', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveSourceLockedRetrievalQuery({
        userQuery:
          'From Selected Procedure.pdf document: Summarize that as a checklist.',
        effectiveUserQuery:
          'From Selected Procedure.pdf document: Summarize that as a checklist.',
        retrievalQuery: 'stale previous topic',
        semanticQuery: { explicitSource: 'Selected Procedure.pdf' },
        sourceLockDecision: {
          active: true,
          lockedManualId: 'manual-1',
          lockedManualTitle: 'Selected Procedure.pdf',
          lockedDocumentId: 'doc-1',
          reason: 'explicit_source',
        },
      }),
    ).toBe('Summarize that as a checklist.');

    expect(
      (service as any).resolveSourceLockedRetrievalQuery({
        userQuery:
          'From SOP 12.31 Bunkering v2.pdf document: i will have bunkering soon, describe me step by step procedure',
        effectiveUserQuery:
          'From SOP 12.31 Bunkering v2.pdf document: i will have bunkering soon, describe me step by step procedure',
        retrievalQuery: 'stale previous topic',
        semanticQuery: { explicitSource: 'SOP 12.31 Bunkering v2.pdf' },
        sourceLockDecision: {
          active: true,
          lockedManualId: 'manual-1',
          lockedManualTitle: 'SOP 12.31 Bunkering v2.pdf',
          lockedDocumentId: 'doc-1',
          reason: 'explicit_source',
        },
      }),
    ).toBe(
      'i will have bunkering soon, describe me step by step procedure',
    );
  });

  it('keeps explicit source queries intact when there is no generated source-selection question', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveSourceLockedRetrievalQuery({
        userQuery: 'Use Selected Procedure.pdf as the source',
        effectiveUserQuery: 'Use Selected Procedure.pdf as the source',
        retrievalQuery: 'stale previous topic',
        semanticQuery: { explicitSource: 'Selected Procedure.pdf' },
        sourceLockDecision: {
          active: true,
          lockedManualId: 'manual-1',
          lockedManualTitle: 'Selected Procedure.pdf',
          lockedDocumentId: 'doc-1',
          reason: 'explicit_source',
        },
      }),
    ).toBe('Use Selected Procedure.pdf as the source');
  });

  it('prefers the semantic shortlist when a narrow tag scope conflicts with it', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveRetrievalManualScope({
        sourceLockDecision: {
          active: false,
          lockedManualId: null,
          lockedManualTitle: null,
          lockedDocumentId: null,
          reason: null,
        },
        semanticManualIds: ['manual-generic-1', 'manual-generic-2'],
        tagScopedManualIds: ['manual-tagged'],
      }),
    ).toEqual(['manual-generic-1', 'manual-generic-2']);
  });

  it('falls back to tag scope when no semantic shortlist is available', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveRetrievalManualScope({
        sourceLockDecision: {
          active: false,
          lockedManualId: null,
          lockedManualTitle: null,
          lockedDocumentId: null,
          reason: null,
        },
        semanticManualIds: [],
        tagScopedManualIds: ['manual-tagged'],
      }),
    ).toEqual(['manual-tagged']);
  });

  it('does not widen to the full dataset when semantic scope has no citations and tag scope adds nothing new', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      (service as any).resolveSafeFallbackManualScope({
        baseAllowedManualIds: ['manual-turbodrive'],
        tagScopedManualIds: undefined,
      }),
    ).toBeUndefined();
    expect(
      (service as any).resolveSafeFallbackManualScope({
        baseAllowedManualIds: ['manual-turbodrive'],
        tagScopedManualIds: ['manual-turbodrive'],
      }),
    ).toBeUndefined();
    expect(
      (service as any).resolveSafeFallbackManualScope({
        baseAllowedManualIds: ['manual-turbodrive'],
        tagScopedManualIds: ['manual-turbodrive', 'manual-catalogue'],
      }),
    ).toEqual(['manual-turbodrive', 'manual-catalogue']);
  });

  it('records shortlisted manual titles from the selected semantic scope instead of the full raw candidate tail', () => {
    const service = new ChatDocumentationService(
      {} as never,
      new ChatDocumentationQueryService(),
      {} as never,
      {} as never,
      {} as never,
    );

    const trace = (service as any).buildRetrievalTrace({
      userQuery: 'how to install an alarm?',
      retrievalQuery: 'how to install an alarm?',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'maintenance_procedure',
        conceptFamily: 'asset_system',
        selectedConceptIds: ['tag:equipment:bilge:alarm'],
        candidateConceptIds: ['tag:equipment:bilge:alarm'],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: 'installation',
        answerFormat: 'step_by_step',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.42,
      },
      semanticCandidates: [
        {
          manualId: 'manual-bilgmon',
          documentId: 'doc-bilgmon',
          filename: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
          category: 'MANUALS',
          score: 180,
          reasons: ['secondary_concept'],
        },
        {
          manualId: 'manual-fs1575',
          documentId: 'doc-fs1575',
          filename: 'FS1575_2575_5075_IME56770R2.pdf',
          category: 'MANUALS',
          score: 112,
          reasons: ['intent'],
        },
      ],
      shortlistedManualIds: ['manual-bilgmon'],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
    });

    expect(trace.shortlistedManualIds).toEqual(['manual-bilgmon']);
    expect(trace.shortlistedManualTitles).toEqual([
      'bilgmon488_instruction_manual_vAE - 2020.pdf',
    ]);
  });

  it('passes the resolved semantic manual scope into scan fallbacks when tag scope is broader and conflicting', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: [] }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
    const tankCitation: ChatCitation = {
      shipManualId: 'manual-semantic',
      sourceTitle: 'Fuel Tank Sounding Table.pdf',
      snippet: 'Fuel tank capacities are listed in the sounding table.',
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'general_information' as const,
      conceptFamily: 'asset_system' as const,
      selectedConceptIds: ['tag:system:fuel'],
      candidateConceptIds: ['tag:system:fuel'],
      equipment: ['fuel tanks'],
      systems: ['fuel'],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS' as const],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'tank capacities',
      answerFormat: 'table' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.79,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-semantic',
          documentId: 'doc-semantic',
          filename: 'Fuel Tank Sounding Table.pdf',
          category: 'MANUALS',
          score: 164,
          reasons: ['section_hint', 'profile_text'],
        },
      ]),
    };
    const tagLinks = {
      findTaggedManualIdsForShipQuery: jest
        .fn()
        .mockResolvedValue([
          'manual-tag-1',
          'manual-tag-2',
          'manual-tag-3',
          'manual-tag-4',
        ]),
      findTaggedManualIdsForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      tagLinks as never,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
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
      ['manual-semantic'],
    ]);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shipManualId: 'manual-semantic',
          sourceTitle: 'Fuel Tank Sounding Table.pdf',
        }),
      ]),
    );
  });

  it('relaxes semantic manual scope for counter-based maintenance follow-ups so history docs remain available', async () => {
    const contextService = {
      findContextForQuery: jest.fn().mockResolvedValue({ citations: [] }),
      findContextForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const queryService = new ChatDocumentationQueryService();
    const citationService = new ChatDocumentationCitationService(queryService);
    const maintenanceCitation: ChatCitation = {
      shipManualId: 'manual-history-1',
      sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
      sourceCategory: 'HISTORY_PROCEDURES',
      snippet:
        'Component name: SB ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE',
      score: 1,
    };
    const scanService = {
      expandReferenceDocumentChunkCitations: jest.fn().mockResolvedValue([]),
      expandMaintenanceAssetDocumentChunkCitations: jest
        .fn()
        .mockResolvedValue([maintenanceCitation]),
      expandManualIntervalMaintenanceChunkCitations: jest
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
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure' as const,
      conceptFamily: 'asset_system' as const,
      selectedConceptIds: ['tag:equipment:electrical:generator_sb'],
      candidateConceptIds: ['tag:equipment:electrical:generator_sb'],
      equipment: ['generator'],
      systems: ['electrical'],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS' as const, 'HISTORY_PROCEDURES' as const],
      explicitSource: null,
      pageHint: null,
      sectionHint: '500-hour maintenance',
      answerFormat: 'checklist' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.78,
    };
    const semanticNormalizer = {
      normalize: jest.fn().mockResolvedValue(semanticQuery),
    };
    const semanticMatcher = {
      shortlistManuals: jest.fn().mockResolvedValue([
        {
          manualId: 'manual-wrong',
          documentId: 'doc-wrong',
          filename: 'Tecnical data sheet_2AF10A27_rev00.pdf',
          category: 'MANUALS',
          score: 171,
          reasons: ['profile_text'],
        },
      ]),
    };
    const tagLinks = {
      findTaggedManualIdsForShipQuery: jest
        .fn()
        .mockResolvedValue(['manual-history-1', 'manual-history-2']),
      findTaggedManualIdsForAdminQuery: jest.fn().mockResolvedValue([]),
    };
    const sourceLockService = {
      getFollowUpStateFromHistory: jest.fn().mockReturnValue(null),
      resolveSourceLock: jest.fn().mockReturnValue({
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      }),
      buildNextFollowUpState: jest.fn().mockReturnValue(null),
    };

    const service = new ChatDocumentationService(
      contextService as never,
      queryService,
      citationService,
      scanService,
      referenceExtractionService,
      undefined,
      tagLinks as never,
      semanticNormalizer as never,
      semanticMatcher as never,
      sourceLockService as never,
    );

    const result = await service.prepareDocumentationContext({
      shipId: 'ship-1',
      role: 'user',
      userQuery: 'should i perform any maintenance at this counter?',
    });

    expect((contextService.findContextForQuery as jest.Mock).mock.calls[0][5]).toEqual([
      'manual-history-1',
      'manual-history-2',
    ]);
    expect((contextService.findContextForQuery as jest.Mock).mock.calls[0][4]).toEqual(
      expect.arrayContaining(['HISTORY_PROCEDURES']),
    );
    expect(
      (
        scanService.expandMaintenanceAssetDocumentChunkCitations as jest.Mock
      ).mock.calls[0][5],
    ).toEqual(['manual-history-1', 'manual-history-2']);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shipManualId: 'manual-history-1',
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        }),
      ]),
    );
  });
});
