import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TOKEN_SECRET: "test-token-secret", ADMIN_SECRET: "test-admin", GLOBAL_DAILY_CAP: "1000" },
      },
    }),
  ],
});
