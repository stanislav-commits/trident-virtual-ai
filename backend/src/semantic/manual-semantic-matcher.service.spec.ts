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
      queryText: 'What is the safe procedure for entering an enclosed space?',
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
            filename: 'MN_ACB531 spare parts catalogue.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'parts_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: ['spare_parts_catalog'],
              secondaryConceptIds: [],
              systems: [],
              equipment: ['pump'],
              vendor: null,
              model: null,
              aliases: [],
              summary: 'Generic spare parts catalogue with seal kits.',
              sections: [],
              pageTopics: [],
            },
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
      selectedConceptIds: ['spare_parts_catalog'],
      candidateConceptIds: ['spare_parts_catalog'],
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
      queryText: 'Which spare parts are in the Turbodrive 240 H.C.T. seal kit?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-model-catalogue',
        reasons: expect.arrayContaining(['filename_overlap', 'query_anchor']),
      }),
    );
  });

  it('lets a distinctive filename anchor beat a generic profile match', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-generic-converter',
            ragflowDocumentId: 'doc-generic-converter',
            filename: 'Generic converter manual.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'general_information',
              sourceCategory: 'MANUALS',
              primaryConceptIds: ['tag:equipment:navigation:converter'],
              secondaryConceptIds: [],
              systems: ['navigation display'],
              equipment: ['converter'],
              vendor: null,
              model: null,
              aliases: [],
              summary: 'General converter information.',
              sections: [],
              pageTopics: [],
            },
          },
          {
            id: 'manual-distinctive-vendor',
            ragflowDocumentId: 'doc-distinctive-vendor',
            filename: '42805_LINDY_MAN_0817.pdf',
            category: 'MANUALS',
            semanticProfile: null,
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'general_information',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['tag:equipment:navigation:converter'],
      candidateConceptIds: ['tag:equipment:navigation:converter'],
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
      confidence: 0.7,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText:
        'What does the LINDY converter say about connecting SDI to HDMI?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-distinctive-vendor',
        reasons: expect.arrayContaining(['query_anchor']),
      }),
    );
  });

  it('prefers helm-station manual evidence over generic transfer procedures', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-volvo',
            ragflowDocumentId: 'doc-volvo',
            filename: 'Volvo Penta operators manual.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['helm station', 'control system'],
              equipment: ['control levers', 'helm station panel'],
              vendor: 'Volvo Penta',
              model: null,
              aliases: ['active station', 'station activation'],
              summary:
                'Procedures for changing and activating helm stations and transferring control between stations.',
              sections: [
                {
                  title: 'Changing and Activating Helm Stations',
                  pageStart: 70,
                  pageEnd: 72,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Move control levers to neutral, activate the helm station, and transfer control.',
                },
              ],
              pageTopics: [],
            },
          },
          {
            id: 'manual-bunkering',
            ragflowDocumentId: 'doc-bunkering',
            filename: 'Procedures - Bunkering and Transfers (3).pdf',
            category: 'HISTORY_PROCEDURES',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'HISTORY_PROCEDURES',
              primaryConceptIds: ['bunkering_operation'],
              secondaryConceptIds: [],
              systems: ['fuel system'],
              equipment: [],
              vendor: null,
              model: null,
              aliases: ['fuel transfer'],
              summary:
                'Procedure for bunkering, fuel transfer monitoring, and spill prevention.',
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
      conceptFamily: 'asset_system',
      selectedConceptIds: ['helm_station_control'],
      candidateConceptIds: ['helm_station_control', 'bunkering_operation'],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.78,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'How do I transfer control to another helm station?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS', 'HISTORY_PROCEDURES'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-volvo',
        reasons: expect.arrayContaining(['source_preference', 'profile_text']),
      }),
    );
    expect(candidates[0].score).toBeGreaterThan(
      candidates.find((candidate) => candidate.manualId === 'manual-bunkering')
        ?.score ?? 0,
    );
  });

  it('does not let generic transfer wording beat helm-station evidence', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-volvo',
            ragflowDocumentId: 'doc-volvo',
            filename: 'Volvo Penta_operators manual_47710211.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'manual_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['Electronic Vessel Control system'],
              equipment: ['External Helm', 'control levers'],
              vendor: 'Volvo Penta',
              model: 'D13',
              aliases: ['Operator manual D13'],
              summary:
                'Operator manual covering operation, alarms, emergency actions, maintenance, settings and technical data.',
              sections: [
                {
                  title: 'Operation',
                  pageStart: 65,
                  pageEnd: 90,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Operating procedures for the engine and control system.',
                },
              ],
              pageTopics: [],
            },
          },
          {
            id: 'manual-bunkering',
            ragflowDocumentId: 'doc-bunkering',
            filename: 'Procedures - Bunkering and Transfers (3).pdf',
            category: 'REGULATION',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'regulation_compliance',
              sourceCategory: 'REGULATION',
              primaryConceptIds: ['bunkering_operation'],
              secondaryConceptIds: [],
              systems: ['fuel system'],
              equipment: ['bunkering hose', 'tank vents', 'fuel meter'],
              vendor: null,
              model: null,
              aliases: ['fuel transfer', 'fuel oil transfers'],
              summary:
                'Procedure for bunkering, fuel transfer monitoring, and spill prevention.',
              sections: [
                {
                  title: 'Centrifugal Fuel Separator',
                  pageStart: 8,
                  pageEnd: 8,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Fuel transfer and centrifuge control cabinet checks.',
                },
              ],
              pageTopics: [],
            },
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['helm_station_control'],
      candidateConceptIds: ['helm_station_control', 'bunkering_operation'],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
      explicitSource: null,
      pageHint: null,
      sectionHint: null,
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.78,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'How do I transfer control to another helm station?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS', 'REGULATION'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({ manualId: 'manual-volvo' }),
    );
    expect(
      candidates.find((candidate) => candidate.manualId === 'manual-bunkering')
        ?.score ?? 0,
    ).toBeLessThan(candidates[0].score);
  });

  it('does not rank generic guide/start-up text above converter evidence', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-fridge',
            ragflowDocumentId: 'doc-fridge',
            filename: 'Vitrifrigo_Fridge mod. c50i.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'manual_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: [],
              equipment: ['refrigerator', 'compressor', 'thermostat'],
              vendor: 'Vitrifrigo',
              model: 'C50I',
              aliases: ['fridge manual'],
              summary:
                "Manual intended as a guide to the appliance's proper use.",
              sections: [
                {
                  title: 'Start-up',
                  pageStart: 10,
                  pageEnd: 11,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary: 'Start-up and temperature adjustment.',
                },
              ],
              pageTopics: [],
            },
          },
          {
            id: 'manual-converter',
            ragflowDocumentId: 'doc-converter',
            filename: 'Power converter manual.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'manual_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['shore power'],
              equipment: ['power converter', 'interface module', 'LCD display'],
              vendor: null,
              model: 'SPC-II',
              aliases: ['shore power converter'],
              summary: 'Manual for a power converter and its interface module.',
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
      intent: 'manual_lookup',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['tag:equipment:navigation:converter'],
      candidateConceptIds: ['tag:equipment:navigation:converter'],
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
      confidence: 0.7,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'What information is in the converter quick-start guide?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({ manualId: 'manual-converter' }),
    );
  });
});
