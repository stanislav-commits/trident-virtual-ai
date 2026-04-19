type EnvRecord = Record<string, unknown>;

export function validateEnvironment(config: EnvRecord): EnvRecord {
  const portValue = config.PORT;
  const port =
    typeof portValue === 'string' ? Number.parseInt(portValue, 10) : Number(portValue ?? 3000);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  if (config.NODE_ENV && typeof config.NODE_ENV !== 'string') {
    throw new Error('NODE_ENV must be a string when provided');
  }

  if (!config.DB_HOST || typeof config.DB_HOST !== 'string') {
    throw new Error('DB_HOST must be provided');
  }

  if (!config.DB_PORT || Number.isNaN(Number(config.DB_PORT))) {
    throw new Error('DB_PORT must be provided as a valid integer');
  }

  if (!config.DB_NAME || typeof config.DB_NAME !== 'string') {
    throw new Error('DB_NAME must be provided');
  }

  if (!config.DB_USER || typeof config.DB_USER !== 'string') {
    throw new Error('DB_USER must be provided');
  }

  if (!config.DB_PASSWORD || typeof config.DB_PASSWORD !== 'string') {
    throw new Error('DB_PASSWORD must be provided');
  }

  if (!config.JWT_SECRET || typeof config.JWT_SECRET !== 'string') {
    throw new Error('JWT_SECRET must be provided');
  }

  return config;
}
