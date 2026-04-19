export interface DatabaseRuntimeConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  sslRejectUnauthorized: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDatabaseEnv(
  source: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig {
  return {
    host: source.DB_HOST ?? 'localhost',
    port: parsePort(source.DB_PORT, 5433),
    name: source.DB_NAME ?? 'trident_virtual_ai',
    user: source.DB_USER ?? 'postgres',
    password: source.DB_PASSWORD ?? 'postgres',
    ssl: parseBoolean(source.DB_SSL, false),
    sslRejectUnauthorized: parseBoolean(
      source.DB_SSL_REJECT_UNAUTHORIZED,
      true,
    ),
  };
}
