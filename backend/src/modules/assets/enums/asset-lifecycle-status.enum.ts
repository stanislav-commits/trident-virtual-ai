export enum AssetLifecycleStatus {
  IN_SERVICE = 'in-service',
  SPECIFIED = 'specified',     // planned / specified but not yet installed
  DEPRECATED = 'deprecated',   // replaced or retired
  CROSS_REF = 'cross-ref',     // a placeholder pointing elsewhere
}
