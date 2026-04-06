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
});
