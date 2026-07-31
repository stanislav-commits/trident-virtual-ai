import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from '../documents/entities/document.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { RelatedAssetResult } from './dto/related-asset.dto';
import { AssetDocumentLinkEntity } from './entities/asset-document-link.entity';
import { AssetEntity } from './entities/asset.entity';
import { AssetsService } from './assets.service';

/**
 * What is attached to an asset: its bound telemetry, its manuals, its
 * drawings — and the pinning and suppression that decide which of those the
 * operator sees.
 *
 * Its own service because linking is the part of the register that reaches
 * outside it, into documents and the metric catalogue. Keeping it here is
 * what lets AssetsService hold only the register's own rows.
 */
@Injectable()
export class AssetLinksService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    private readonly assetsService: AssetsService,
  ) {}

  /**
   * Fetch the asset + everything bound to it: AI-bound metrics (via
   * ship_metric_catalog.bound_asset_id FK) and documents that match the
   * asset's brand+model (loose match — RAGFlow-style equipment retrieval).
   * Used by the admin Asset Register UI to render the side detail panel.
   */
  async getRelated(
    shipId: string,
    assetId: string,
  ): Promise<RelatedAssetResult> {
    const asset = await this.assetsService.getOne(shipId, assetId);

    // 1. Metrics bound by AI via bound_asset_id FK.
    const metrics = await this.metricCatalogRepository.find({
      where: { shipId, boundAssetId: asset.id },
      order: { key: 'ASC' as const },
    });

    // 2. Documents matching this asset's manufacturer/model. The RAGFlow
    // chat tool uses brand+model+displayName at query time; we mirror that
    // matching logic for the admin view but with a fuzzy-loose AND (brand
    // must match if present; model is bonus).
    // (a) Explicitly linked documents via asset_documents junction
    const explicitLinks = await this.assetDocLinkRepository.find({
      where: { assetId: asset.id },
      relations: { document: true },
      order: { createdAt: 'DESC' },
    });
    const explicit = explicitLinks
      .filter((l) => l.linkType !== 'excluded')
      .map((l) => l.document)
      .filter((d): d is DocumentEntity => Boolean(d));

    // No live brand/model auto-match here: it produced dozens of wrong hits
    // (a FURUNO manual matched every FURUNO asset; a Gianneschi boiler manual
    // every Gianneschi tank) that the operator couldn't see or control.
    // Manuals are linked to assets ONCE at upload by the extractor's strict
    // brand+model match (real pinned links), and thereafter only explicitly.
    const explicitIds = new Set(explicit.map((d) => d.id));

    // PLANS live in their own list: they are file pointers (never parsed),
    // shown on the Overview — the Manuals tab is manuals/procedures only.
    const isPlan = (d: DocumentEntity) => d.docClass === 'plan';
    const nonPlan = explicit.filter((d) => !isPlan(d));

    // Drawings: explicit plan links only. Plans are drawing-code auto-linked
    // ONCE at upload as real pinned links (see autoLinkPlanByDrawingCode), so
    // there is no live phantom match here — what shows is real and editable.
    const drawingDocs: DocumentEntity[] = explicit.filter(isPlan);

    const documents = nonPlan;

    return {
      asset,
      metrics: metrics.map((m) => {
        // key is formatted "bucket::measurement::field" — parse the
        // middle segment so the frontend has a clean display value.
        const parts = m.key.split('::');
        const measurement = parts.length >= 3 ? parts[1] : m.bucket;
        return {
          id: m.id,
          key: m.key,
          bucket: m.bucket,
          measurement,
          field: m.field,
          aiDescription: m.aiDescription,
          aiKind: m.aiKind,
          aiUnit: m.aiUnit,
          aiBoundConfidence: m.aiBoundConfidence,
          aiGeneratedAt: m.aiGeneratedAt,
        };
      }),
      documents: documents.map((d) => ({
        id: d.id,
        originalFileName: d.originalFileName,
        manufacturer: d.manufacturer,
        model: d.model,
        equipmentName: d.equipmentName,
        docClass: d.docClass,
        parseStatus: d.parseStatus,
        createdAt: d.createdAt,
        linkSource: explicitIds.has(d.id) ? 'explicit' as const : 'auto' as const,
      })),
      drawings: drawingDocs.map((d) => ({
        id: d.id,
        originalFileName: d.originalFileName,
        manufacturer: d.manufacturer,
        model: d.model,
        equipmentName: d.equipmentName,
        docClass: d.docClass,
        parseStatus: d.parseStatus,
        createdAt: d.createdAt,
        linkSource: explicitIds.has(d.id) ? 'explicit' as const : 'auto' as const,
      })),
    };
  }

  /**
   * Pin a document to an asset (explicit link via asset_documents junction).
   * Idempotent — if the link already exists we silently no-op so the UI can
   * click "+ Link" without checking first.
   */
  async linkDocument(
    shipId: string,
    assetId: string,
    documentId: string,
    userId: string | null,
  ): Promise<void> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    const doc = await this.documentRepository.findOne({
      where: { id: documentId, shipId },
    });
    if (!doc) {
      throw new NotFoundException(
        `Document ${documentId} not found on ship ${shipId}`,
      );
    }

    const existing = await this.assetDocLinkRepository.findOne({
      where: { assetId, documentId },
    });
    if (existing?.linkType === 'pinned') return; // idempotent
    // Re-linking an excluded document flips the suppression back to a pin.
    await this.assetDocLinkRepository.save({
      assetId,
      documentId,
      linkType: 'pinned',
      createdByUserId: userId,
    });
  }

  /**
   * Detach a document from an asset. For a pinned link this deletes the
   * row; for an auto-match (no pinned row) it saves an 'excluded'
   * suppression so the fuzzy matcher stops re-attaching the document.
   */
  async unlinkDocument(
    shipId: string,
    assetId: string,
    documentId: string,
  ): Promise<void> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    const existing = await this.assetDocLinkRepository.findOne({
      where: { assetId, documentId },
    });

    if (existing?.linkType === 'pinned') {
      await this.assetDocLinkRepository.delete({ assetId, documentId });
      return;
    }

    const doc = await this.documentRepository.findOne({
      where: { id: documentId, shipId },
    });
    if (!doc) {
      throw new NotFoundException(
        `Document ${documentId} not found on ship ${shipId}`,
      );
    }

    await this.assetDocLinkRepository.save({
      assetId,
      documentId,
      linkType: 'excluded',
    });
  }
}
