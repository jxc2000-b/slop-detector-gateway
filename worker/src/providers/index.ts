import { pangram } from "./pangram";
import type { Provider, ProviderRoute } from "./types";

export type { Provider, ProviderRoute };

// Register new upstream APIs here.
export const PROVIDERS: Record<string, Provider> = {
  [pangram.id]: pangram,
};

export function matchRoute(
  provider: Provider,
  method: string,
  path: string,
): { route: ProviderRoute; params: string[] } | undefined {
  for (const route of provider.routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return undefined;
}
