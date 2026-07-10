import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IsEnum } from 'class-validator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import {
  ASSIGNABLE_POSITIONS,
  AccessPosition,
  DEPARTMENTS,
  departmentForPosition,
  MATRIX_CATEGORIES,
  PermissionLevel,
  POSITION_LABELS,
  RESOURCE_CATEGORY_LABELS,
  ResourceCategory,
} from './access-positions';
import { AccessControlService } from './access-control.service';

class SetCellDto {
  @IsEnum(AccessPosition)
  position!: AccessPosition;

  @IsEnum(ResourceCategory)
  resourceCategory!: ResourceCategory;

  @IsEnum(PermissionLevel)
  level!: PermissionLevel;
}

@Controller('access-control')
@UseGuards(JwtAuthGuard)
export class AccessControlController {
  constructor(private readonly accessControlService: AccessControlService) {}

  /**
   * The logged-in user's own effective access on their ship — for the UI to
   * hide/read-only surfaces. `restricted:false` (admins + crew-unlinked users)
   * means no gating; otherwise `permissions` holds the position's row.
   */
  @Get('me')
  async myAccess(@CurrentUser() user: AuthenticatedUser) {
    if (user.role === UserRole.ADMIN || !user.shipId) {
      return { restricted: false, position: null, permissions: null };
    }
    const resolved = await this.accessControlService.resolveForUser(
      user.id,
      user.shipId,
    );
    if (!resolved) {
      return { restricted: false, position: null, permissions: null };
    }
    return {
      restricted: true,
      position: resolved.position,
      permissions: resolved.permissions,
    };
  }

  /**
   * THE single taxonomy the whole admin UI renders from: access positions (with
   * labels + their department), the canonical department list, and matrix
   * categories (with labels). No UI should hardcode these lists.
   */
  @Get('schema')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  schema() {
    return {
      positions: ASSIGNABLE_POSITIONS.map((p) => ({
        value: p,
        label: POSITION_LABELS[p],
        department: departmentForPosition(p),
      })),
      departments: DEPARTMENTS,
      resourceCategories: MATRIX_CATEGORIES.map((c) => ({
        value: c,
        label: RESOURCE_CATEGORY_LABELS[c],
      })),
      levels: Object.values(PermissionLevel),
    };
  }

  @Get('matrix/:shipId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  getMatrix(@Param('shipId') shipId: string) {
    return this.accessControlService.getMatrix(shipId);
  }

  @Put('matrix/:shipId/cell')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async setCell(@Param('shipId') shipId: string, @Body() body: SetCellDto) {
    await this.accessControlService.setCell(
      shipId,
      body.position,
      body.resourceCategory,
      body.level,
    );
    return this.accessControlService.getMatrix(shipId);
  }
}
