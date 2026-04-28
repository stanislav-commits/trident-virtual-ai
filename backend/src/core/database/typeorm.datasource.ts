import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChatSessionMemoryEntity } from '../../modules/chat/context/entities/chat-session-memory.entity';
import { ChatMessageEntity } from '../../modules/chat/entities/chat-message.entity';
import { ChatSessionEntity } from '../../modules/chat/entities/chat-session.entity';
import { UserEntity } from '../../modules/users/entities/user.entity';
import { ShipEntity } from '../../modules/ships/entities/ship.entity';
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
  ],
  synchronize: false,
  ssl: db.ssl
    ? {
        rejectUnauthorized: db.sslRejectUnauthorized,
      }
    : undefined,
});

export default dataSource;
