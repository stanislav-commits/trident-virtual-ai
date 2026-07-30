import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import type { AuthenticatedUser } from '../../core/auth/auth.types';
import { LlmPriceBookService, ModelPriceRow } from './llm-price-book.service';

/**
 * The rate card, editable from the admin panel.
 *
 * Admin-only: these numbers decide what a client is billed, and the change
 * takes effect on the next model call across every vessel — the widest blast
 * radius of any field in the panel.
 */
@Controller('llm-prices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class LlmPricesController {
  constructor(private readonly priceBook: LlmPriceBookService) {}

  @Get()
  list(): Promise<ModelPriceRow[]> {
    return this.priceBook.list();
  }

  /** Add a model or re-rate one. Returns the whole card back. */
  @Put()
  upsert(
    @Body()
    body: {
      modelPrefix: string;
      inputPerMTok: number;
      outputPerMTok: number;
      note?: string | null;
    },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ModelPriceRow[]> {
    return this.priceBook.upsert(body, user.id ?? null);
  }

  /**
   * Removing a model does not un-price the calls already recorded against it —
   * they carry their own rates. It stops NEW calls being priced, which is what
   * you want for a model that is no longer offered at that rate.
   */
  @Delete(':modelPrefix')
  remove(
    @Param('modelPrefix') modelPrefix: string,
  ): Promise<ModelPriceRow[]> {
    return this.priceBook.remove(modelPrefix);
  }
}
