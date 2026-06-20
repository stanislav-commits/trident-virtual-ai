import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { SfiService } from './sfi.service';

/**
 * Read-only SFI taxonomy. Any authenticated user may read it — it drives the
 * group/sub-group pickers and register validation.
 */
@Controller('sfi')
@UseGuards(JwtAuthGuard)
export class SfiController {
  constructor(private readonly sfi: SfiService) {}

  @Get('groups')
  groups() {
    return this.sfi.groups();
  }

  @Get('groups/:groupCode/subs')
  subs(
    @Param('groupCode') groupCode: string,
    @Query('level') level?: string,
  ) {
    const parsed = level ? Number.parseInt(level, 10) : 2;
    return this.sfi.subs(groupCode, Number.isFinite(parsed) ? parsed : 2);
  }

  @Get('taxonomy')
  all() {
    return this.sfi.all();
  }
}
