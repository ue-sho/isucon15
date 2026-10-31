export type Config = {
  region: string;
  dbHost: string;
  dbPort: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  logLevel: string;
  imageCacheDir?: string;
};

export function configFromEnv(): Config {
  return {
    region: envOrDefault("ISUREAL_REGION", "asia"),
    dbHost: envOrDefault("ISUREAL_DB_HOST", "127.0.0.1"),
    dbPort: envOrDefault("ISUREAL_DB_PORT", "5432"),
    dbUser: envOrDefault("ISUREAL_DB_USER", "isureal"),
    dbPassword: envOrDefault("ISUREAL_DB_PASSWORD", "isureal"),
    dbName: envOrDefault("ISUREAL_DB_NAME", "isureal"),
    logLevel: envOrDefault("ISUREAL_LOG_LEVEL", "debug"),
    imageCacheDir: envOrDefault("ISUREAL_IMAGE_CACHE_DIR", "") || undefined,
  };
}

export function envOrDefault(key: string, defaultValue: string): string {
  const value = process.env[key];
  if (value) {
    return value;
  }
  return defaultValue;
}

export function appPortFromEnv(): number {
  const value = envOrDefault("ISUREAL_PORT", "8080");
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid application port");
  }
  return port;
}
