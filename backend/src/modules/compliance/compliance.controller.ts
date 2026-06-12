import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import {
  ComplianceService,
  UpsertComplianceDocInput,
} from './compliance.service';

@Controller('ships/:shipId/compliance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Post('instantiate')
  @Roles(UserRole.ADMIN)
  instantiate(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body()
    body: {
      gtBucket?: string;
      grossTonnage?: number;
      lengthM?: number;
      operationType?: string;
      flagRegistry?: string | null;
    },
  ) {
    return this.complianceService.instantiateForShip(shipId, body);
  }

  @Get('overview')
  overview(@Param('shipId', ParseUUIDPipe) shipId: string) {
    return this.complianceService.overview(shipId);
  }

  @Get('assets/:assetId/docs')
  listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.complianceService.listForAsset(shipId, assetId);
  }

  @Post('docs')
  @Roles(UserRole.ADMIN)
  createDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: UpsertComplianceDocInput,
  ) {
    return this.complianceService.createDoc(shipId, body);
  }

  @Patch('docs/:docId')
  @Roles(UserRole.ADMIN)
  updateDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() body: Partial<UpsertComplianceDocInput>,
  ) {
    return this.complianceService.updateDoc(shipId, docId, body);
  }

  @Delete('docs/:docId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ): Promise<void> {
    await this.complianceService.deleteDoc(shipId, docId);
  }

  @Patch('types/:typeId')
  @Roles(UserRole.ADMIN)
  updateType(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Body()
    body: {
      applicability?: string;
      renewalCycle?: string | null;
      surveyWindow?: string | null;
      updateTrigger?: string | null;
      notes?: string | null;
    },
  ) {
    return this.complianceService.updateType(shipId, typeId, body);
  }
}
