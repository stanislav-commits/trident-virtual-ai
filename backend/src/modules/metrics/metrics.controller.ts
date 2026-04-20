import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { QueryMetricsDto } from './dto/query-metrics.dto';
import { CreateMetricConceptDto } from './dto/create-metric-concept.dto';
import { ResolveMetricConceptDto } from './dto/resolve-metric-concept.dto';
import { ExecuteMetricConceptDto } from './dto/execute-metric-concept.dto';
import { ListShipMetricCatalogQueryDto } from './dto/list-ship-metric-catalog-query.dto';
import { ListMetricConceptsQueryDto } from './dto/list-metric-concepts-query.dto';
import { UpdateShipMetricDescriptionDto } from './dto/update-ship-metric-description.dto';
import { UpdateMetricConceptDto } from './dto/update-metric-concept.dto';
import { MetricsCatalogService } from './metrics-catalog.service';
import { MetricsConceptExecutionService } from './metrics-concept-execution.service';
import { MetricsSemanticBootstrapService } from './metrics-semantic-bootstrap.service';
import { MetricsSemanticCatalogService } from './metrics-semantic-catalog.service';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly metricsCatalogService: MetricsCatalogService,
    private readonly metricsConceptExecutionService: MetricsConceptExecutionService,
    private readonly metricsSemanticBootstrapService: MetricsSemanticBootstrapService,
    private readonly metricsSemanticCatalogService: MetricsSemanticCatalogService,
  ) {}

  @Get('catalog')
  getCatalog() {
    return this.metricsService.getCatalog();
  }

  @Get('ships/:shipId/catalog')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getShipCatalog(@Param('shipId') shipId: string) {
    return this.metricsCatalogService.listShipCatalog(shipId);
  }

  @Get('ships/:shipId/catalog/items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getShipCatalogPage(
    @Param('shipId') shipId: string,
    @Query() query: ListShipMetricCatalogQueryDto,
  ) {
    return this.metricsCatalogService.listShipCatalogPage(shipId, query);
  }

  @Post('ships/:shipId/sync')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  syncShipCatalog(@Param('shipId') shipId: string) {
    return this.metricsCatalogService.syncShipCatalog(shipId);
  }

  @Post('ships/:shipId/bootstrap-semantic-concepts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  bootstrapSemanticConcepts(@Param('shipId') shipId: string) {
    return this.metricsSemanticBootstrapService.bootstrapShipCatalog(shipId);
  }

  @Patch('catalog/:metricId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateMetricDescription(
    @Param('metricId') metricId: string,
    @Body() body: UpdateShipMetricDescriptionDto,
  ) {
    return this.metricsCatalogService.updateMetricDescription(
      metricId,
      body.description,
    );
  }

  @Get('concepts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listConcepts(@Query('shipId') shipId?: string) {
    return this.metricsSemanticCatalogService.listConcepts(shipId);
  }

  @Get('concepts/items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listConceptsPage(@Query() query: ListMetricConceptsQueryDto) {
    return this.metricsSemanticCatalogService.listConceptsPage(query);
  }

  @Post('concepts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createConcept(@Body() body: CreateMetricConceptDto) {
    return this.metricsSemanticCatalogService.createConcept(body);
  }

  @Patch('concepts/:conceptId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateConcept(
    @Param('conceptId') conceptId: string,
    @Body() body: UpdateMetricConceptDto,
  ) {
    return this.metricsSemanticCatalogService.updateConcept(conceptId, body);
  }

  @Post('concepts/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  resolveConcept(@Body() body: ResolveMetricConceptDto) {
    return this.metricsSemanticCatalogService.resolveConcept(body);
  }

  @Post('concepts/execute')
  executeConcept(
    @Body() body: ExecuteMetricConceptDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.metricsConceptExecutionService.execute({
      ...body,
      shipId: user.role === UserRole.ADMIN ? body.shipId : user.shipId ?? undefined,
    });
  }

  @Post('query')
  query(@Body() body: QueryMetricsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.metricsService.query({
      ...body,
      shipId: user.role === UserRole.ADMIN ? body.shipId : user.shipId ?? undefined,
    });
  }
}
