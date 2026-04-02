export class BulkRemoveTagsDto {
  mode?: 'tagIds' | 'all';
  tagIds?: string[];
  excludeTagIds?: string[];
  category?: string;
  subcategory?: string;
  search?: string;
}
