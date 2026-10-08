export interface ProviderRoute {
  method: "GET" | "POST";
  // Matched against the path after /v1/<provider>. Capture groups feed `upstream`.
  pattern: RegExp;
  upstream: (...params: string[]) => string;
  // Billable units charged against the device's daily quota. 0 = rate limited only.
  cost: number;
  // "issue": the response creates a task owned by the caller (id read via taskIdFrom).
  // "require": the first capture group is a task id the caller must own.
  ownership?: "issue" | "require";
  taskIdFrom?: (body: unknown) => string | undefined;
  maxBodyBytes?: number;
}

export interface Provider {
  id: string;
  baseUrl: string;
  // Name of the env binding (Secrets Store secret) holding the upstream key.
  secretBinding: string;
  applyAuth: (headers: Headers, key: string) => void;
  routes: ProviderRoute[];
}
