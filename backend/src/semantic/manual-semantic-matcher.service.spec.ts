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

  it('boosts manuals linked to a matching equipment tag above generic procedures', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-oem-pump',
            ragflowDocumentId: 'doc-oem-pump',
            filename: 'MN_MACB531.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['spare_parts_catalog'],
              systems: ['bilge pumping', 'fire-fighting', 'diesel transfer'],
              equipment: ['centrifugal self-priming pump', 'diesel engine'],
              vendor: 'Gianneschi Pumps and Blowers',
              model: 'MACB531',
              aliases: ['MACB 531'],
              summary:
                'Operating manual for a diesel-driven self-priming pump with installation, starting, maintenance and spare parts.',
              sections: [],
              pageTopics: [],
            },
            tags: [
              {
                tag: {
                  key: 'equipment:bilge:pump_emergency',
                  category: 'equipment',
                  subcategory: 'bilge',
                  item: 'pump_emergency',
                  description: 'Emergency diesel-driven bilge and fire pump.',
                },
              },
            ],
          },
          {
            id: 'manual-generic-procedure',
            ragflowDocumentId: 'doc-generic-procedure',
            filename: 'Common Maintenance and Procedure Tasks.pdf',
            category: 'HISTORY_PROCEDURES',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'HISTORY_PROCEDURES',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['general machinery'],
              equipment: ['fuel filter'],
              vendor: null,
              model: null,
              aliases: ['routine maintenance'],
              summary:
                'General maintenance tasks for filters, lubricants, and routine inspections.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['tag:equipment:bilge:pump_emergency'],
      candidateConceptIds: ['tag:equipment:bilge:pump_emergency'],
      equipment: ['emergency bilge pump', 'fuel filter'],
      systems: ['bilge', 'fuel'],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'fuel filter replacement',
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.88,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'how to replace fuel filter on emergency bilge pump',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS', 'HISTORY_PROCEDURES'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-oem-pump',
        reasons: expect.arrayContaining(['manual_tag', 'manual_tag_text']),
      }),
    );
  });

  it('filters out installation-oriented manuals that lack concrete subject evidence', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-mini-alarm',
            ragflowDocumentId: 'doc-mini-alarm',
            filename: 'Mini Alarm Instruction Manual Atex.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['tag:equipment:bilge:alarm'],
              systems: [
                'hazardous area electrical installation',
                'intrinsic safety',
              ],
              equipment: [
                'IS-mA1AN minialarm sounder',
                'alarm sounder',
                'sounder',
              ],
              vendor: 'European Safety Systems Ltd.',
              model: 'IS-mA1AN',
              aliases: ['Mini Alarm', 'minialarm sounder'],
              summary:
                'Instruction manual for IS-mA1AN intrinsically safe sounder covering installation and hazardous-area wiring.',
              sections: [
                {
                  title: 'Mounting',
                  pageStart: 4,
                  pageEnd: 4,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Mount base to a flat surface and complete minialarm installation wiring.',
                },
              ],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-bilgmon',
            ragflowDocumentId: 'doc-bilgmon',
            filename: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'manual_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['tag:equipment:bilge:alarm'],
              systems: ['bilge monitoring', 'fresh water flushing'],
              equipment: ['BilgMon488', '15 ppm bilge alarm'],
              vendor: 'Brannstrom Sweden AB',
              model: 'BilgMon488',
              aliases: ['BilgMon 488'],
              summary:
                'Instruction manual for BilgMon488 15 ppm bilge alarm covering installation and maintenance.',
              sections: [
                {
                  title: 'Installation',
                  pageStart: 8,
                  pageEnd: 12,
                  conceptIds: ['tag:equipment:bilge:alarm'],
                  sectionType: 'procedure',
                  summary:
                    'Mechanical and electrical installation for BilgMon488.',
                },
              ],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-furuno',
            ragflowDocumentId: 'doc-furuno',
            filename: 'FS1575_2575_5075_IME56770R2.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['SSB radiotelephone', 'wiring'],
              equipment: ['FS-1575', 'FS-2575', 'FS-5075'],
              vendor: 'FURUNO',
              model: 'FS-1575/FS-2575/FS-5075',
              aliases: ['SSB radiotelephone'],
              summary:
                'Installation manual for Furuno SSB radiotelephone with wiring and grounding.',
              sections: [
                {
                  title: 'How to Install the System',
                  pageStart: 11,
                  pageEnd: 15,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Installation procedures for control unit and antenna coupler.',
                },
              ],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-furuno',
            ragflowDocumentId: 'doc-furuno',
            filename: 'FS1575_2575_5075_IME56770R2.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['SSB radiotelephone', 'antenna coupler'],
              equipment: ['FS-1575', 'FS-2575', 'FS-5075'],
              vendor: 'FURUNO',
              model: 'FS-1575/FS-2575/FS-5075',
              aliases: ['SSB radiotelephone'],
              summary:
                'Installation manual for Furuno radiotelephone equipment.',
              sections: [
                {
                  title: 'How to Install the System',
                  pageStart: 11,
                  pageEnd: 20,
                  conceptIds: [],
                  sectionType: 'procedure',
                  summary:
                    'Installation procedures for the control unit and antenna coupler.',
                },
              ],
              pageTopics: [],
            },
            tags: [],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['tag:equipment:bilge:alarm'],
      candidateConceptIds: ['tag:equipment:bilge:alarm'],
      equipment: ['alarm'],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'installation',
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.31,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'how to install minialarm?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-mini-alarm',
        reasons: expect.arrayContaining(['concrete_subject']),
      }),
    );
  });

  it('keeps multiple candidates for broad alarm-installation queries without a concrete subject anchor', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-mini-alarm',
            ragflowDocumentId: 'doc-mini-alarm',
            filename: 'Mini Alarm Instruction Manual Atex.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['tag:equipment:bilge:alarm'],
              systems: ['hazardous area electrical installation'],
              equipment: ['alarm sounder'],
              vendor: null,
              model: null,
              aliases: ['Mini Alarm'],
              summary: 'Alarm installation manual for an intrinsically safe sounder.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-bilgmon',
            ragflowDocumentId: 'doc-bilgmon',
            filename: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'manual_lookup',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['tag:equipment:bilge:alarm'],
              systems: ['bilge monitoring'],
              equipment: ['15 ppm bilge alarm'],
              vendor: null,
              model: null,
              aliases: ['BilgMon 488'],
              summary: 'Bilge alarm instruction manual with installation section.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: ['tag:equipment:bilge:alarm'],
      candidateConceptIds: ['tag:equipment:bilge:alarm'],
      equipment: [],
      systems: [],
      vendor: null,
      model: null,
      sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION'],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'installation',
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.42,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'how to install an alarm?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates.map((candidate) => candidate.manualId)).toEqual(
      expect.arrayContaining(['manual-mini-alarm', 'manual-bilgmon']),
    );
    expect(candidates.map((candidate) => candidate.manualId)).not.toContain(
      'manual-furuno',
    );
  });

  it('filters out same-vendor manuals with conflicting model identifiers when an exact equipment subject exists', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-fa170',
            ragflowDocumentId: 'doc-fa170',
            filename: 'FA170_IME44900J.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['AIS', 'GNSS antenna system'],
              equipment: ['FA-170', 'AIS transponder', 'monitor unit'],
              vendor: 'FURUNO',
              model: 'FA-170',
              aliases: ['Class A AIS', 'Automatic Identification System'],
              summary:
                'Installation and setup manual for the Furuno FA-170 AIS transponder.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-gp170',
            ragflowDocumentId: 'doc-gp170',
            filename: 'GP170_IME44820J.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['navigation', 'wiring'],
              equipment: ['GP-170', 'display unit', 'antenna unit'],
              vendor: 'FURUNO',
              model: 'GP-170',
              aliases: ['GPS/GLONASS'],
              summary:
                'Installation and wiring manual for the Furuno GP-170 navigator.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: ['AIS transponder'],
      systems: ['AIS'],
      vendor: 'FURUNO',
      model: 'FA-170',
      sourcePreferences: ['MANUALS'],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'installation',
      answerFormat: 'step_by_step',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.84,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'How do I install the Furuno FA-170 AIS transponder?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-fa170',
      }),
    );
  });

  it('prefers a vendor-specific battery manual over a generic sibling battery manual', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-akasol',
            ragflowDocumentId: 'doc-akasol',
            filename:
              '35 - 510323E - Akasol Batteries Installation Philosophy Rev E.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['battery space ventilation', 'cooling system'],
              equipment: ['Akasol battery modules', 'Master String Manager'],
              vendor: 'Akasol',
              model: null,
              aliases: ['battery installation philosophy'],
              summary:
                'Installation philosophy for Akasol battery packs with ventilation and cooling data.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
          {
            id: 'manual-ebusco',
            ragflowDocumentId: 'doc-ebusco',
            filename: 'Instruction_Manual_EMB.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['battery system', 'liquid cooling system'],
              equipment: ['power battery system', 'battery box'],
              vendor: 'Ebusco',
              model: 'Maritime Battery',
              aliases: ['battery pack'],
              summary:
                'Instruction manual for Ebusco Maritime Battery covering installation and cooling.',
              sections: [],
              pageTopics: [],
            },
            tags: [],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'asset_system',
      selectedConceptIds: [],
      candidateConceptIds: [],
      equipment: ['battery modules'],
      systems: ['battery space ventilation'],
      vendor: 'Akasol',
      model: null,
      sourcePreferences: ['MANUALS'],
      explicitSource: null,
      pageHint: null,
      sectionHint: 'ventilation',
      answerFormat: 'direct_answer',
      needsClarification: false,
      clarificationReason: null,
      confidence: 0.8,
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'What ventilation rate is required for the Akasol battery room?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-akasol',
      }),
    );
  });

  it('prefers an asset-specific generator manual over a generic maintenance checklist for broad 500-hour queries', async () => {
    const prisma = {
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-mase',
            ragflowDocumentId: 'doc-mase',
            filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: [],
              systems: ['electrical system', 'fuel circuit', 'cooling system'],
              equipment: ['generator set', 'genset', 'generator unit'],
              vendor: 'MASE Generators',
              model: 'VS 350 SV',
              aliases: ['marine generator'],
              summary:
                'Use, maintenance and installation manual for a marine genset with periodic checks and maintenance intervals.',
              sections: [
                {
                  title: 'Periodic checks and maintenance',
                  pageStart: 69,
                  pageEnd: 69,
                  conceptIds: [],
                  sectionType: 'checklist',
                  summary:
                    'Periodic maintenance schedule for the generator set with hour-based intervals.',
                },
              ],
              pageTopics: [
                {
                  page: 69,
                  conceptIds: [],
                  summary:
                    'Periodic checks and maintenance table for the generator set including 500-hour items.',
                },
              ],
            },
            tags: [
              {
                tag: {
                  key: 'equipment:electrical:generator_ps',
                  category: 'equipment',
                  subcategory: 'electrical',
                  item: 'generator_ps',
                  description: 'Port-side diesel generator.',
                },
              },
            ],
          },
          {
            id: 'manual-common',
            ragflowDocumentId: 'doc-common',
            filename: 'Common Maintenance and Procedure Tasks.pdf',
            category: 'MANUALS',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'maintenance_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: ['maintenance_checklist'],
              secondaryConceptIds: ['tag:equipment:electrical:emergency_generator'],
              systems: ['hydraulic systems', 'movement systems'],
              equipment: ['electrical control panels', 'wire ropes'],
              vendor: null,
              model: null,
              aliases: ['routine maintenance'],
              summary:
                'Rossinavi procedures for emergency manual operation and general maintenance.',
              sections: [
                {
                  title: 'Hydraulic Power Units - Routine Checks',
                  pageStart: 10,
                  pageEnd: 12,
                  conceptIds: ['maintenance_checklist'],
                  sectionType: 'checklist',
                  summary:
                    'Routine checks for hydraulic systems and emergency generator support.',
                },
              ],
              pageTopics: [
                {
                  page: 13,
                  conceptIds: ['maintenance_checklist'],
                  summary:
                    'Periodic hydraulic maintenance intervals and replacement guidance.',
                },
              ],
            },
            tags: [
              {
                tag: {
                  key: 'equipment:electrical:emergency_generator',
                  category: 'equipment',
                  subcategory: 'electrical',
                  item: 'emergency_generator',
                  description: 'Emergency generator support system.',
                },
              },
            ],
          },
        ]),
      },
    } as any;
    const service = new ManualSemanticMatcherService(prisma);
    const semanticQuery: DocumentationSemanticQuery = {
      schemaVersion: '2026-04-06.semantic-v2',
      intent: 'maintenance_procedure',
      conceptFamily: 'maintenance_topic',
      selectedConceptIds: [],
      candidateConceptIds: [
        'maintenance_checklist',
        'tag:equipment:electrical:emergency_generator',
        'tag:equipment:electrical:generator_ps',
        'tag:equipment:electrical:generator_sb',
      ],
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
    };

    const candidates = await service.shortlistManuals({
      shipId: null,
      role: 'admin',
      queryText: 'what is included in the 500-hour diesel generator maintenance?',
      semanticQuery,
      allowedDocumentCategories: ['MANUALS'],
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        manualId: 'manual-mase',
        reasons: expect.arrayContaining([
          'equipment_overlap',
          'system_overlap',
        ]),
      }),
    );
    expect(candidates[0].score).toBeGreaterThan(
      candidates.find((candidate) => candidate.manualId === 'manual-common')
        ?.score ?? 0,
    );
  });
});
