import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { ToggleShipMetricsDto } from './dto/toggle-ship-metrics.dto';
import { MetricsCatalogService } from './metrics-catalog.service';
import { MetricsConceptExecutionService } from './metrics-concept-execution.service';
import { MetricsSemanticBootstrapService } from './metrics-semantic-bootstrap.service';
import { MetricsSemanticClusterService } from './metrics-semantic-cluster.service';
import { MetricsSemanticCatalogService } from './metrics-semantic-catalog.service';
import { MetricsService } from './metrics.service';
import { MetricAnalyzerResponderService } from './metric-understanding/metric-analyzer-responder.service';
import {
  IssueSeverity,
  MetricQualityDetectorService,
} from './metric-understanding/metric-quality-detector.service';
import { MetricUnderstandingService } from './metric-understanding/metric-understanding.service';
import { AnalyzeShipOptions } from './metric-understanding/metric-understanding.types';

@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly metricsCatalogService: MetricsCatalogService,
    private readonly metricsConceptExecutionService: MetricsConceptExecutionService,
    private readonly metricsSemanticBootstrapService: MetricsSemanticBootstrapService,
    private readonly metricsSemanticClusterService: MetricsSemanticClusterService,
    private readonly metricsSemanticCatalogService: MetricsSemanticCatalogService,
    private readonly metricUnderstandingService: MetricUnderstandingService,
    private readonly metricAnalyzerResponderService: MetricAnalyzerResponderService,
    private readonly metricQualityDetectorService: MetricQualityDetectorService,
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

  @Post('ships/:shipId/cluster-semantic-groups')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  clusterSemanticGroups(
    @Param('shipId') shipId: string,
    @Query('dryRun') dryRun?: string,
    @Query('strategy') strategy?: string,
  ) {
    const allowedStrategies = new Set(['measurement', 'higher_order', 'both']);
    const normalized = (strategy ?? '').toLowerCase();
    const safeStrategy = allowedStrategies.has(normalized)
      ? (normalized as 'measurement' | 'higher_order' | 'both')
      : 'measurement';
    return this.metricsSemanticClusterService.clusterShipConcepts(shipId, {
      strategy: safeStrategy,
      dryRun: dryRun === '1' || dryRun === 'true',
    });
  }

  @Post('ships/:shipId/bootstrap-semantic-concepts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  bootstrapSemanticConcepts(@Param('shipId') shipId: string) {
    return this.metricsSemanticBootstrapService.bootstrapShipCatalog(shipId);
  }

  @Patch('ships/:shipId/catalog/toggle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  toggleShipMetrics(
    @Param('shipId') shipId: string,
    @Body() body: ToggleShipMetricsDto,
  ) {
    return this.metricsCatalogService.toggleShipMetrics(shipId, body);
  }

  /** Other metrics from the same device (same-measurement siblings). */
  @Get('catalog/:metricId/similar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findSimilarMetrics(@Param('metricId') metricId: string) {
    return this.metricsCatalogService.findSimilarMetrics(metricId);
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
      body.boundAssetId,
      body.aiUnit,
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

  @Delete('concepts/:conceptId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  deleteConcept(
    @Param('conceptId') conceptId: string,
    @Query('shipId') shipId?: string,
  ) {
    return this.metricsSemanticCatalogService.deleteConceptFromShip(
      conceptId,
      shipId,
    );
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

  // ── AI metric understanding (Phase 2) ──────────────────────────────────

  @Post('ships/:shipId/analyze')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  analyzeShipMetrics(
    @Param('shipId') shipId: string,
    @Body() body: AnalyzeShipOptions,
  ) {
    if (body?.background) {
      return this.metricUnderstandingService.analyzeForShipBackground(
        shipId,
        body,
      );
    }
    return this.metricUnderstandingService.analyzeForShip(shipId, body ?? {});
  }

  @Get('ships/:shipId/analyze/progress')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  analyzeShipMetricsProgress(@Param('shipId') shipId: string) {
    const p = this.metricUnderstandingService.getProgress(shipId);
    return { shipId, progress: p };
  }

  @Post('catalog/:metricId/analyze')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  analyzeSingleMetric(@Param('metricId') metricId: string) {
    return this.metricUnderstandingService.analyzeOne(metricId);
  }

  @Get('ships/:shipId/analyze/issues')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  analyzeShipMetricsIssues(
    @Param('shipId') shipId: string,
    @Query('severity') severity?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const validSeverities: IssueSeverity[] = ['high', 'medium', 'low'];
    const sev = severity
      ? validSeverities.find((s) => s === severity)
      : undefined;
    const parsedLimit = limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 50)) : 50;
    const parsedOffset = offset ? Math.max(0, parseInt(offset, 10) || 0) : 0;
    return this.metricQualityDetectorService.detectForShip(shipId, {
      severity: sev,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  // Phase 3 — tool-calling resolver. Direct REST entry point; routing from
  // the chat pipeline happens in a separate task.
  @Post('ships/:shipId/ask')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  askMetric(
    @Param('shipId') shipId: string,
    @Body() body: { question: string },
  ) {
    return this.metricAnalyzerResponderService.answer(shipId, body?.question);
  }

  @Post('query')
  query(@Body() body: QueryMetricsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.metricsService.query({
      ...body,
      shipId: user.role === UserRole.ADMIN ? body.shipId : user.shipId ?? undefined,
    });
  }
}
