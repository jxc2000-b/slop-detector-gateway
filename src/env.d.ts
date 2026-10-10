interface Env {
  METER: DurableObjectNamespace<import("./meter").Meter>;
  PANGRAM_API_KEY: SecretsStoreSecret;
  TOKEN_SECRET: SecretsStoreSecret;
  ADMIN_SECRET: SecretsStoreSecret;
  GLOBAL_DAILY_CAP: string;
}
