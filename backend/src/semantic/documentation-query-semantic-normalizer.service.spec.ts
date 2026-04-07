import { ConceptCatalogService } from './concept-catalog.service';
import { DocumentationQuerySemanticNormalizerService } from './documentation-query-semantic-normalizer.service';
import { SemanticLlmService } from './semantic-llm.service';

describe('DocumentationQuerySemanticNormalizerService', () => {
  const buildService = (semanticLlmResult: Record<string, unknown>) => {
    const conceptCatalog = {
      shortlistFamilies: jest.fn().mockResolvedValue(['maintenance_topic']),
      shortlistConcepts: jest.fn().mockResolvedValue([
        {
          conceptId: 'troubleshooting_guide',
          label: 'Troubleshooting guide',
          family: 'maintenance_topic',
          score: 12,
        },
      ]),
      listConcepts: jest.fn().mockResolvedValue([
        {
          id: 'troubleshooting_guide',
          family: 'maintenance_topic',
          label: 'Troubleshooting guide',
          description: 'Fault handling and corrective action guidance.',
          aliases: ['alarm handling', 'fault handling'],
          sourcePreferences: ['MANUALS'],
        },
      ]),
      getConceptById: jest.fn().mockResolvedValue(null),
    } as unknown as ConceptCatalogService;
    const semanticLlm = {
      isConfigured: jest.fn().mockReturnValue(true),
      generateStructuredObject: jest.fn().mockResolvedValue(semanticLlmResult),
    } as unknown as SemanticLlmService;

    return new DocumentationQuerySemanticNormalizerService(
      conceptCatalog,
      semanticLlm,
    );
  };

  it('does not treat contextual this-manual wording as an explicit source', async () => {
    const service = buildService({
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
      explicitSource: 'this manual',
      pageHint: null,
      sectionHint: 'emergency',
      answerFormat: 'direct_answer',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.82,
    });

    const result = await service.normalize({
      userQuery: 'What does the emergency section say in this manual?',
      retrievalQuery:
        'acknowledge engine alarm and find corrective action What does the emergency section say in this manual?',
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
    });

    expect(result.explicitSource).toBeNull();
    expect(result.sectionHint).toBe('emergency');
  });

  it('keeps procedure-oriented regulation sources available even when the model narrows to manuals', async () => {
    const service = buildService({
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'operational_procedure',
      conceptFamily: 'operational_topic',
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: [],
      systems: ['fuel_system'],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS'],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'checklist',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.9,
    });

    const result = await service.normalize({
      userQuery: 'What should I do before taking fuel onboard?',
      retrievalQuery: 'What should I do before taking fuel onboard?',
    });

    expect(result.sourcePreferences).toEqual(
      expect.arrayContaining(['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION']),
    );
  });

  it('uses concept source preferences before generic operational source routing', async () => {
    const conceptCatalog = {
      shortlistFamilies: jest.fn().mockResolvedValue(['asset_system']),
      shortlistConcepts: jest.fn().mockResolvedValue([
        {
          conceptId: 'helm_station_control',
          label: 'Helm station control',
          family: 'asset_system',
          score: 22,
        },
        {
          conceptId: 'bunkering_operation',
          label: 'Bunkering operation',
          family: 'operational_topic',
          score: 2,
        },
      ]),
      listConcepts: jest.fn().mockResolvedValue([
        {
          id: 'helm_station_control',
          family: 'asset_system',
          label: 'Helm station control',
          description: 'Transfer vessel control between helm stations.',
          aliases: ['helm station', 'transfer control'],
          sourcePreferences: ['MANUALS'],
        },
        {
          id: 'bunkering_operation',
          family: 'operational_topic',
          label: 'Bunkering operation',
          description: 'Receiving fuel onboard and monitoring transfer.',
          aliases: ['bunkering', 'fuel transfer'],
          sourcePreferences: ['HISTORY_PROCEDURES', 'REGULATION'],
        },
      ]),
      getConceptById: jest.fn().mockResolvedValue(null),
    } as unknown as ConceptCatalogService;
    const semanticLlm = {
      isConfigured: jest.fn().mockReturnValue(false),
      generateStructuredObject: jest.fn(),
    } as unknown as SemanticLlmService;
    const service = new DocumentationQuerySemanticNormalizerService(
      conceptCatalog,
      semanticLlm,
    );

    const result = await service.normalize({
      userQuery: 'How do I transfer control to another helm station?',
      retrievalQuery: 'How do I transfer control to another helm station?',
    });

    expect(result.selectedConceptIds).toEqual(['helm_station_control']);
    expect(result.sourcePreferences[0]).toBe('MANUALS');
  });
});
