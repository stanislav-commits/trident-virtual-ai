import { DocumentationSourceLockService } from './documentation-source-lock.service';

describe('DocumentationSourceLockService', () => {
  const service = new DocumentationSourceLockService();

  it('reuses the previous documentation lock for page follow-ups', () => {
    const followUpState = service.getFollowUpStateFromHistory([
      {
        role: 'assistant',
        content: 'Use page 70.',
        ragflowContext: {
          usedDocumentation: true,
          documentationFollowUpState: {
            schemaVersion: '2026-04-06.semantic-v1',
            intent: 'manual_lookup',
            conceptIds: ['sewage_treatment_system'],
            sourcePreferences: ['MANUALS'],
            sourceLock: true,
            lockedManualId: 'manual-1',
            lockedManualTitle: 'Blue Sea Plus.pdf',
            lockedDocumentId: 'doc-1',
            pageHint: 70,
            sectionHint: null,
            vendor: null,
            model: null,
            systems: [],
            equipment: [],
          },
        },
        contextReferences: [],
      },
      { role: 'user', content: 'page 71' },
    ]);

    const decision = service.resolveSourceLock({
      userQuery: 'page 71',
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v1',
        intent: 'manual_lookup',
        conceptFamily: 'asset_system',
        selectedConceptIds: ['sewage_treatment_system'],
        candidateConceptIds: ['sewage_treatment_system'],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: 71,
        sectionHint: null,
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.9,
      },
      followUpState,
      candidates: [],
    });

    expect(decision).toMatchObject({
      active: true,
      lockedManualId: 'manual-1',
      lockedManualTitle: 'Blue Sea Plus.pdf',
      lockedDocumentId: 'doc-1',
      reason: 'page_or_section_follow_up',
    });
  });

  it('skips contextless documentation clarification prompts when recovering the last source lock', () => {
    const followUpState = service.getFollowUpStateFromHistory([
      {
        role: 'assistant',
        content: 'Manual answer with evidence.',
        ragflowContext: {
          usedDocumentation: true,
          documentationFollowUpState: {
            schemaVersion: '2026-04-06.semantic-v2',
            intent: 'manual_lookup',
            conceptIds: [],
            sourcePreferences: ['MANUALS'],
            sourceLock: true,
            lockedManualId: 'manual-handbook',
            lockedManualTitle: 'Marine Application Handbook.pdf',
            lockedDocumentId: 'doc-handbook',
            pageHint: null,
            sectionHint: null,
            vendor: null,
            model: null,
            systems: [],
            equipment: [],
          },
        },
        contextReferences: [],
      },
      { role: 'user', content: 'Which tables or diagrams are relevant?' },
      {
        role: 'assistant',
        content: 'Which source should I use?',
        ragflowContext: {
          awaitingClarification: true,
          clarificationDomain: 'documentation',
          clarificationReason: 'semantic_source_ambiguous',
        },
        contextReferences: [],
      },
      { role: 'user', content: 'What are the limitations?' },
    ]);

    expect(followUpState).toMatchObject({
      sourceLock: true,
      lockedManualId: 'manual-handbook',
      lockedManualTitle: 'Marine Application Handbook.pdf',
      lockedDocumentId: 'doc-handbook',
    });
  });

  it('builds a reusable follow-up state from single-source citations', () => {
    const state = service.buildNextFollowUpState({
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v1',
        intent: 'operational_procedure',
        conceptFamily: 'operational_topic',
        selectedConceptIds: ['bunkering_operation'],
        candidateConceptIds: ['bunkering_operation'],
        equipment: [],
        systems: ['fuel_system'],
        vendor: null,
        model: null,
        sourcePreferences: ['HISTORY_PROCEDURES'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'step_by_step',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.92,
      },
      retrievalQuery: 'Describe the bunkering procedure step by step.',
      citations: [
        {
          shipManualId: 'manual-2',
          sourceTitle: 'Bunkering procedure.pdf',
          sourceCategory: 'HISTORY_PROCEDURES',
        },
      ],
      candidates: [
        {
          manualId: 'manual-2',
          documentId: 'doc-2',
          filename: 'Bunkering procedure.pdf',
          category: 'HISTORY_PROCEDURES',
          score: 42,
          reasons: ['primary_concept'],
        },
      ],
      sourceLockDecision: {
        active: false,
        lockedManualId: null,
        lockedManualTitle: null,
        lockedDocumentId: null,
        reason: null,
      },
    });

    expect(state).toMatchObject({
      intent: 'operational_procedure',
      conceptIds: ['bunkering_operation'],
      retrievalQuery: 'Describe the bunkering procedure step by step.',
      sourceLock: true,
      lockedManualId: 'manual-2',
      lockedDocumentId: 'doc-2',
    });
  });

  it('reuses the previous documentation lock for contextual this-manual follow-ups', () => {
    const decision = service.resolveSourceLock({
      userQuery: 'What does the emergency section say in this manual?',
      normalizedQuery: {
        rawQuery: 'What does the emergency section say in this manual?',
        normalizedQuery:
          'acknowledge engine alarm and corrective action emergency section',
        retrievalQuery:
          'acknowledge engine alarm and find corrective action What does the emergency section say in this manual?',
        effectiveQuery:
          'acknowledge engine alarm and find corrective action What does the emergency section say in this manual?',
        previousUserQuery:
          'How should I acknowledge an engine alarm and find the corrective action?',
        followUpMode: 'follow_up',
        subject: 'acknowledge engine alarm and corrective action emergency',
        operation: 'lookup',
        timeIntent: { kind: 'none' },
        sourceHints: ['DOCUMENTATION'],
        isClarificationReply: false,
        ambiguityFlags: [],
      },
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
        sectionHint: 'emergency',
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.82,
      },
      followUpState: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'manual_lookup',
        conceptIds: ['troubleshooting_guide'],
        sourcePreferences: ['MANUALS'],
        sourceLock: true,
        lockedManualId: 'manual-volvo',
        lockedManualTitle: 'Volvo Penta_operators manual_47710211.pdf',
        lockedDocumentId: 'doc-volvo',
        pageHint: null,
        sectionHint: null,
        vendor: null,
        model: null,
        systems: [],
        equipment: [],
      },
      candidates: [
        {
          manualId: 'manual-bilgmon',
          documentId: 'doc-bilgmon',
          filename: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
          category: 'MANUALS',
          score: 122,
          reasons: ['profile_text'],
        },
        {
          manualId: 'manual-volvo',
          documentId: 'doc-volvo',
          filename: 'Volvo Penta_operators manual_47710211.pdf',
          category: 'MANUALS',
          score: 122,
          reasons: ['profile_text'],
        },
      ],
    });

    expect(decision).toMatchObject({
      active: true,
      lockedManualId: 'manual-volvo',
      lockedManualTitle: 'Volvo Penta_operators manual_47710211.pdf',
      lockedDocumentId: 'doc-volvo',
      reason: 'page_or_section_follow_up',
    });
  });

  it('reuses the previous documentation lock for short generic detail follow-ups', () => {
    const decision = service.resolveSourceLock({
      userQuery: 'What are the quantities?',
      normalizedQuery: {
        rawQuery: 'What are the quantities?',
        normalizedQuery: 'what are the quantities?',
        retrievalQuery: 'What are the quantities?',
        effectiveQuery: 'What are the quantities?',
        previousUserQuery:
          'From MN_ACB531.pdf document: Which kit contains the O-rings and lip seals for the waterjet?',
        followUpMode: 'standalone',
        subject: 'quantities',
        operation: 'lookup',
        timeIntent: { kind: 'none' },
        sourceHints: [],
        isClarificationReply: false,
        ambiguityFlags: [],
      },
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'general_information',
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
        confidence: 0.42,
      },
      followUpState: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'parts_lookup',
        conceptIds: [],
        sourcePreferences: ['MANUALS'],
        sourceLock: true,
        lockedManualId: 'manual-acb531',
        lockedManualTitle: 'MN_ACB531.pdf',
        lockedDocumentId: 'doc-acb531',
        pageHint: null,
        sectionHint: null,
        vendor: null,
        model: null,
        systems: [],
        equipment: [],
      },
      candidates: [],
    });

    expect(decision).toMatchObject({
      active: true,
      lockedManualId: 'manual-acb531',
      lockedManualTitle: 'MN_ACB531.pdf',
      lockedDocumentId: 'doc-acb531',
      reason: 'follow_up_source_lock',
    });
  });

  it('keeps the selected manual for generic table and limitation follow-ups', () => {
    const followUpState = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'manual_lookup' as const,
      conceptIds: [],
      sourcePreferences: ['MANUALS' as const],
      sourceLock: true,
      lockedManualId: 'manual-handbook',
      lockedManualTitle: 'Marine Application Handbook.pdf',
      lockedDocumentId: 'doc-handbook',
      pageHint: null,
      sectionHint: null,
      vendor: null,
      model: null,
      systems: [],
      equipment: [],
    };
    const semanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'general_information' as const,
      conceptFamily: 'asset_system',
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS' as const],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'direct_answer' as const,
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.5,
    };

    for (const userQuery of [
      'Which tables or diagrams are relevant?',
      'What are the limitations?',
      'Can you summarize the process for a new engineer?',
      'What page is this from?',
    ]) {
      expect(
        service.resolveSourceLock({
          userQuery,
          semanticQuery,
          followUpState,
          candidates: [],
        }),
      ).toMatchObject({
        active: true,
        lockedManualId: 'manual-handbook',
        lockedManualTitle: 'Marine Application Handbook.pdf',
        reason: 'follow_up_source_lock',
      });
    }
  });
});
