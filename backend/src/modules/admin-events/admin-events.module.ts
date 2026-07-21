import { Global, Module } from '@nestjs/common';
import { AdminEventBus } from './admin-event.bus';
import { AdminEventsController } from './admin-events.controller';

/**
 * Global so any domain module can inject AdminEventBus and emit change
 * events without importing this module explicitly.
 */
@Global()
@Module({
  controllers: [AdminEventsController],
  providers: [AdminEventBus],
  exports: [AdminEventBus],
})
export class AdminEventsModule {}
