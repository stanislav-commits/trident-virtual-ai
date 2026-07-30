import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { OverviewService } from './overview.service';
import { OverviewTokens, ShipOverviewResponse } from './overview.types';

/**
 * ADMIN-only, unlike the sibling per-ship read endpoints that carry no `@Roles`.
 * Two reasons: the page only exists inside the admin panel, and this response is
 * a deliberate map of where a vessel's data is thin — which section is empty,
 * which integration never ran. That is operator information, and this repo has
 * no per-ship read check to lean on (RolesGuard only inspects the role, so on
 * every other read endpoint any authenticated user can name any shipId).
 */
@Controller('ships/:shipId/overview')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get()
  getOverview(
    @Param('shipId', ParseUUIDPipe) shipId: string,
  ): Promise<ShipOverviewResponse> {
    return this.overviewService.getShipOverview(shipId);
  }

  /**
   * Spend over a window the operator picked, for the periods a client is billed
   * on rather than the calendar month the page opens with.
   *
   * `from`/`to` are plain calendar days (YYYY-MM-DD) read as UTC, and `to` is
   * INCLUSIVE — the caller asks for "1 to 31 July" and means all of the 31st,
   * so the day is added on here rather than making every caller remember it.
   */
  @Get('spend')
  getSpend(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('model') model?: string,
    @Query('purpose') purpose?: string,
    @Query('user') user?: string,
  ): Promise<OverviewTokens | null> {
    return this.overviewService.getShipSpend(
      shipId,
      parseDay(from, 'from'),
      parseDay(to, 'to', true),
      {
        model: bounded(model, 64, 'model'),
        purpose: bounded(purpose, 48, 'purpose'),
        user: parseUser(user),
      },
    );
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * These land in a WHERE as bound parameters, so the length cap is not about
 * injection — it is about not sending a megabyte of junk to Postgres to compare
 * against a 64-character column.
 */
function bounded(
  value: string | undefined,
  max: number,
  field: string,
): string | undefined {
  if (!value) return undefined;
  if (value.length > max) {
    throw new BadRequestException(`${field} is too long`);
  }
  return value;
}

/** A user id, or the literal 'none' for calls no person initiated. */
function parseUser(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === 'none' || UUID.test(value)) return value;
  throw new BadRequestException("user must be a uuid or 'none'");
}

/** Rejects junk rather than letting `new Date` turn it into an Invalid Date. */
function parseDay(
  value: string | undefined,
  field: string,
  endOfDay = false,
): Date | null {
  if (!value) return null;
  if (!DAY.test(value)) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} is not a real date`);
  }
  if (endOfDay) {
    parsed.setUTCDate(parsed.getUTCDate() + 1);
  }
  return parsed;
}
