interface Env {
  METER: DurableObjectNamespace<import("./meter").Meter>;
  PANGRAM_API_KEY: SecretsStoreSecret;
  TOKEN_SECRET: string;
  ADMIN_SECRET: string;
  GLOBAL_DAILY_CAP: string;
}
