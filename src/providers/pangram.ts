import type { Provider } from "./types";

export const pangram: Provider = {
  id: "pangram",
  baseUrl: "https://text.external-api.pangram.com",
  secretBinding: "PANGRAM_API_KEY",
  applyContentType: (headers) => headers.set("Content-Type", "application/json"),
  applyAuth: (headers, key) => headers.set("x-api-key", key),
  routes: [
    { method: "GET", pattern: /^\/models$/, upstream: () => "/models", cost: 0 },
    {
      method: "POST",
      pattern: /^\/task$/,
      upstream: () => "/task",
      cost: 1,
      ownership: "issue",
      taskIdFrom: (body) => (body as { task_id?: string } | null)?.task_id,
      maxBodyBytes: 256 * 1024,
    },
    {
      method: "GET",
      pattern: /^\/task\/([A-Za-z0-9_-]{1,128})$/,
      upstream: (id) => `/task/${id}`,
      cost: 0,
      ownership: "require",
    },
  ],
};

// TODO: Implement and register gptzero provider