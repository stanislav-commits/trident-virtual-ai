import {
  Controller,
  MessageEvent,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AdminEventBus } from './admin-event.bus';

@Controller('admin/events')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminEventsController {
  constructor(private readonly bus: AdminEventBus) {}

  /**
   * Live stream of admin-panel change events (SSE). Admin-only. EventSource
   * clients authenticate via `?access_token=` (the browser API can't set
   * headers). The client filters/dispatches by `domain` + `shipId`.
   */
  @Sse('stream')
  @Roles(UserRole.ADMIN)
  stream(): Observable<MessageEvent> {
    return this.bus
      .subscribe()
      .pipe(map((event) => ({ data: event }) as MessageEvent));
  }
}
