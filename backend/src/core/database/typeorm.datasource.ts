import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChatSessionMemoryEntity } from '../../modules/chat/context/entities/chat-session-memory.entity';
import { ChatMessageEntity } from '../../modules/chat/entities/chat-message.entity';
import { ChatSessionEntity } from '../../modules/chat/entities/chat-session.entity';
import { UserEntity } from '../../modules/users/entities/user.entity';
import { ShipEntity } from '../../modules/ships/entities/ship.entity';
import { AssetEntity } from '../../modules/assets/entities/asset.entity';
import { AssetDocumentLinkEntity } from '../../modules/assets/entities/asset-document-link.entity';
import { AssetSnapshotEntity } from '../../modules/assets/entities/asset-snapshot.entity';
import { ServiceRuleEntity } from '../../modules/assets/entities/service-rule.entity';
import { DocumentEntity } from '../../modules/documents/entities/document.entity';
import { MetricConceptAliasEntity } from '../../modules/metrics/entities/metric-concept-alias.entity';
import { MetricConceptEntity } from '../../modules/metrics/entities/metric-concept.entity';
import { MetricConceptMemberEntity } from '../../modules/metrics/entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from '../../modules/metrics/entities/ship-metric-catalog.entity';
import { InitAccessControlSchema20260418000100 } from './migrations/20260418000100-init-access-control-schema';
import { RefineShipsRegistrySchema20260419000100 } from './migrations/20260419000100-refine-ships-registry-schema';
import { AddShipMetricCatalog20260419000200 } from './migrations/20260419000200-add-ship-metric-catalog';
import { RemoveShipMetricCatalogMeasurement20260419000300 } from './migrations/20260419000300-remove-ship-metric-catalog-measurement';
import { AddChatSchema20260419000400 } from './migrations/20260419000400-add-chat-schema';
import { AddChatSessionMemory20260419000500 } from './migrations/20260419000500-add-chat-session-memory';
import { AddMetricSemanticCatalog20260419000600 } from './migrations/20260419000600-add-metric-semantic-catalog';
import { FlattenMetricConceptChildMembers20260420000100 } from './migrations/20260420000100-flatten-metric-concept-child-members';
import { AddShipMetricCatalogIsEnabled20260421000100 } from './migrations/20260421000100-add-ship-metric-catalog-is-enabled';
import { AddDocumentsRagflowIngestion20260426000100 } from './migrations/20260426000100-add-documents-ragflow-ingestion';
import { AddDocumentParseProgress20260428000100 } from './migrations/20260428000100-add-document-parse-progress';
import { UseDecimalDocumentParseProgress20260428000200 } from './migrations/20260428000200-use-decimal-document-parse-progress';
import { AddChatSessionTitleStatus20260504000100 } from './migrations/20260504000100-add-chat-session-title-status';
import { AddDocumentBusinessMetadata20260521000100 } from './migrations/20260521000100-add-document-business-metadata';
import { AddMetricConceptRangeAggregationHint20260601000100 } from './migrations/20260601000100-add-metric-concept-range-aggregation-hint';
import { AddAssetsTable20260602000100 } from './migrations/20260602000100-add-assets-table';
import { RebuildAssetsTable20260602000200 } from './migrations/20260602000200-rebuild-assets-table';
import { AddMetricCatalogAiMetadata20260602000300 } from './migrations/20260602000300-add-metric-catalog-ai-metadata';
import { AddAssetDocumentLinks20260609000100 } from './migrations/20260609000100-add-asset-document-links';
import { AddAssetV14LocationFields20260609000200 } from './migrations/20260609000200-add-asset-v14-location-fields';
import { AddAssetSnapshots20260610000100 } from './migrations/20260610000100-add-asset-snapshots';
import { AddServiceRules20260610000200 } from './migrations/20260610000200-add-service-rules';
import { AddAssetDocumentLinkType20260611000100 } from './migrations/20260611000100-add-asset-document-link-type';
import { AddComplianceDocs20260611000200 } from './migrations/20260611000200-add-compliance-docs';
import { AddComplianceMaster20260611000300 } from './migrations/20260611000300-add-compliance-master';
import { ExtendShipProfile20260611000400 } from './migrations/20260611000400-extend-ship-profile';
import { AddDocumentExtraction20260612000100 } from './migrations/20260612000100-add-document-extraction';
import { AddPmsTasks20260618000100 } from './migrations/20260618000100-add-pms-tasks';
import { AddPmsDueHours20260618000200 } from './migrations/20260618000200-add-pms-due-hours';
import { AddAssetHours20260618000300 } from './migrations/20260618000300-add-asset-hours';
import { AddPmsResponsibleRole20260618000400 } from './migrations/20260618000400-add-pms-responsible-role';
import { AddCrew20260618000500 } from './migrations/20260618000500-add-crew';
import { AddPmsDepartment20260618000600 } from './migrations/20260618000600-add-pms-department';
import { TagComplianceArchetypes20260618000700 } from './migrations/20260618000700-tag-compliance-archetypes';
import { AddComplianceDocFields20260618000800 } from './migrations/20260618000800-add-compliance-doc-fields';
import { AddDocAssetLinks20260618000900 } from './migrations/20260618000900-add-doc-asset-links';
import { AddPmsSourceDoc20260618001000 } from './migrations/20260618001000-add-pms-source-doc';
import { AddComplianceIdentityFlags20260618001100 } from './migrations/20260618001100-add-compliance-identity-flags';
import { AddInventory20260619000100 } from './migrations/20260619000100-add-inventory';
import { AddInventoryItemAssets20260619000200 } from './migrations/20260619000200-add-inventory-item-assets';
import { AddPmsTaskAnchors20260619000300 } from './migrations/20260619000300-add-pms-task-anchors';
import { AddInventoryItemTasks20260619000400 } from './migrations/20260619000400-add-inventory-item-tasks';
import { AddSfiTaxonomy20260615000100 } from './migrations/20260615000100-add-sfi-taxonomy';
import { AddSfiTaxonomySource20260615000200 } from './migrations/20260615000200-add-sfi-taxonomy-source';
import { getDatabaseEnv } from './database.config';

const db = getDatabaseEnv();

const dataSource = new DataSource({
  type: 'postgres',
  host: db.host,
  port: db.port,
  database: db.name,
  username: db.user,
  password: db.password,
  entities: [
    UserEntity,
    ShipEntity,
    DocumentEntity,
    ShipMetricCatalogEntity,
    MetricConceptEntity,
    MetricConceptAliasEntity,
    MetricConceptMemberEntity,
    ChatSessionEntity,
    ChatMessageEntity,
    ChatSessionMemoryEntity,
    AssetEntity,
    AssetDocumentLinkEntity,
    AssetSnapshotEntity,
    ServiceRuleEntity,
  ],
  migrations: [
    InitAccessControlSchema20260418000100,
    RefineShipsRegistrySchema20260419000100,
    AddShipMetricCatalog20260419000200,
    RemoveShipMetricCatalogMeasurement20260419000300,
    AddChatSchema20260419000400,
    AddChatSessionMemory20260419000500,
    AddMetricSemanticCatalog20260419000600,
    FlattenMetricConceptChildMembers20260420000100,
    AddShipMetricCatalogIsEnabled20260421000100,
    AddDocumentsRagflowIngestion20260426000100,
    AddDocumentParseProgress20260428000100,
    UseDecimalDocumentParseProgress20260428000200,
    AddChatSessionTitleStatus20260504000100,
    AddDocumentBusinessMetadata20260521000100,
    AddMetricConceptRangeAggregationHint20260601000100,
    AddAssetsTable20260602000100,
    RebuildAssetsTable20260602000200,
    AddMetricCatalogAiMetadata20260602000300,
    AddAssetDocumentLinks20260609000100,
    AddAssetV14LocationFields20260609000200,
    AddAssetSnapshots20260610000100,
    AddServiceRules20260610000200,
    AddAssetDocumentLinkType20260611000100,
    AddComplianceDocs20260611000200,
    AddComplianceMaster20260611000300,
    ExtendShipProfile20260611000400,
    AddDocumentExtraction20260612000100,
    AddPmsTasks20260618000100,
    AddPmsDueHours20260618000200,
    AddAssetHours20260618000300,
    AddPmsResponsibleRole20260618000400,
    AddCrew20260618000500,
    AddPmsDepartment20260618000600,
    TagComplianceArchetypes20260618000700,
    AddComplianceDocFields20260618000800,
    AddDocAssetLinks20260618000900,
    AddPmsSourceDoc20260618001000,
    AddComplianceIdentityFlags20260618001100,
    AddInventory20260619000100,
    AddInventoryItemAssets20260619000200,
    AddPmsTaskAnchors20260619000300,
    AddInventoryItemTasks20260619000400,
    AddSfiTaxonomy20260615000100,
    AddSfiTaxonomySource20260615000200,
  ],
  synchronize: false,
  ssl: db.ssl
    ? {
        rejectUnauthorized: db.sslRejectUnauthorized,
      }
    : undefined,
});

export default dataSource;
