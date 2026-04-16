export const TAG_SUMMARY_SELECT = {
  id: true,
  key: true,
  category: true,
  subcategory: true,
  item: true,
  description: true,
} as const;

export const METRIC_SELECT = {
  key: true,
  label: true,
  description: true,
  unit: true,
  bucket: true,
  measurement: true,
  field: true,
  firstSeenAt: true,
  lastSeenAt: true,
  status: true,
  dataType: true,
  createdAt: true,
  tags: {
    take: 1,
    orderBy: {
      tag: { key: 'asc' },
    },
    select: {
      tag: {
        select: TAG_SUMMARY_SELECT,
      },
    },
  },
} as const;
