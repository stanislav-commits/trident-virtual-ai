import { AssetEntity } from '../entities/asset.entity';

export interface RelatedAssetMetric {
  id: string;
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  aiDescription: string | null;
  aiKind: string | null;
  aiUnit: string | null;
  aiBoundConfidence: number | null;
  aiGeneratedAt: Date | null;
}

export interface RelatedAssetDocument {
  id: string;
  originalFileName: string;
  manufacturer: string | null;
  model: string | null;
  equipmentName: string | null;
  docClass: string;
  parseStatus: string;
  createdAt: Date;
  /**
   * `true` — explicitly linked by an admin via the asset_documents junction.
   * `false` — auto-matched by brand+model substring. UI shows different
   * affordances (explicit links can be unlinked; auto links can only be
   * promoted to explicit).
   */
  linkSource: 'explicit' | 'auto';
}

export interface RelatedAssetResult {
  asset: AssetEntity;
  metrics: RelatedAssetMetric[];
  documents: RelatedAssetDocument[];
}
