import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChatSessionMemoryEntity } from '../../modules/chat/context/entities/chat-session-memory.entity';
import { ChatMessageEntity } from '../../modules/chat/entities/chat-message.entity';
import { ChatSessionEntity } from '../../modules/chat/entities/chat-session.entity';
import { UserEntity } from '../../modules/users/entities/user.entity';
import { ShipEntity } from '../../modules/ships/entities/ship.entity';
import { ShipMetricCatalogEntity } from '../../modules/metrics/entities/ship-metric-catalog.entity';
import { InitAccessControlSchema20260418000100 } from './migrations/20260418000100-init-access-control-schema';
import { RefineShipsRegistrySchema20260419000100 } from './migrations/20260419000100-refine-ships-registry-schema';
import { AddShipMetricCatalog20260419000200 } from './migrations/20260419000200-add-ship-metric-catalog';
import { RemoveShipMetricCatalogMeasurement20260419000300 } from './migrations/20260419000300-remove-ship-metric-catalog-measurement';
import { AddChatSchema20260419000400 } from './migrations/20260419000400-add-chat-schema';
import { AddChatSessionMemory20260419000500 } from './migrations/20260419000500-add-chat-session-memory';
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
    ShipMetricCatalogEntity,
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
  ],
  synchronize: false,
  ssl: db.ssl
    ? {
        rejectUnauthorized: db.sslRejectUnauthorized,
      }
    : undefined,
});

export default dataSource;
