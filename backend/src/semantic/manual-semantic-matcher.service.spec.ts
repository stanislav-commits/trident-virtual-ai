import { ManualSemanticMatcherService } from './manual-semantic-matcher.service';
import type { DocumentationSemanticQuery } from './semantic.types';

describe('ManualSemanticMatcherService', () => {
  it('scores procedure profiles by semantic profile text instead of filename alone', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-enclosed',
            ragflowDocumentId: 'doc-enclosed',
            filename: 'Safety procedure.pdf',
            category: 'REGULATION',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'REGULATION',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: [
                'enclosed spaces safety',
                'permit to work',
                'forced ventilation',
              ],
              equipment: [],
              vendor: null,
              model: null,
              aliases: ['confined space entry'],
              summary:
                'Procedure for entering enclosed spaces, atmosphere testing, ventilation, and standby watch.',
              sections: [
                {
                  title: 'Entry into enclosed spaces',
                  pageStart: 3,
                  pageEnd: 5,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Complete a permit, test the atmosphere, ventilate, and assign a standby person before entry.',
                },
              ],
              pageTopics: [
                {
                  page: 3,
                  conceptIds: [],
                  summary:
                    'Enclosed space entry checklist with atmosphere testing and ventilation.',
                },
              ],
            },
          },
          {
            id: 'manual-generic',
            ragflowDocumentId: 'doc-generic',
            filename: 'General vessel manual.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'general_information',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['deck equipment'],
              equipment: [],
              vendor: null,
              model: null,
              aliases: [],
              summary: 'General vessel information and equipment overview.',
              sections: [],
              pageTopics: [],
            },
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'operational_procedure',
      conceptFamily: 'operational_topic',
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['HISTORY_PROCEDURES', 'REGULATION', 'MANUALS'],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'checklist',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.86,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText:
        'What is the safe procedure for entering an enclosed space?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS', 'REGULATION'],
    });

    expect(prisma.shipManual.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { category: { in: ['MANUALS', 'REGULATION'] } },
      }),
    );
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-enclosed',
        reasons: expect.arrayContaining([
          'intent',
          'profile_source',
          'profile_text',
        ]),
      }),
    );
    expect(candidates[0].score).toBeGreaterThan(
      candidates.find((candidate) => candidate.manualId === 'manual-generic')
        ?.score ?? 0,
    );
  });

  it('uses model-like filename anchors when semantic profiles are unavailable', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-generic-pump',
            ragflowDocumentId: 'doc-generic-pump',
            filename: 'MN_ACB531.pdf',
            category: 'MANUALS',
            semanticProfile: null,
          },
          {
            id: 'manual-model-catalogue',
            ragflowDocumentId: 'doc-model-catalogue',
            filename:
              '901.65966 - Turbodrive 240 H.C.T. - L.V.T. - Spare part catalogue.pdf',
            category: 'MANUALS',
            semanticProfile: null,
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'parts_lookup',
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
      answerFormat: 'table',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.64,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText:
        'Which spare parts are in the Turbodrive 240 H.C.T. seal kit?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-model-catalogue',
        reasons: expect.arrayContaining(['filename_overlap']),
      }),
    );
  });
});
