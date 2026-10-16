// Billable calls each tier may make per provider per UTC day.
// A provider missing from a tier means that tier can't use it.
export const TIERS = {
  free: { pangram: 3 },
  paid: { pangram: 100 },
  admin: { pangram: null }, // No per-device daily quota; assigned only through the admin API.
} as const satisfies Record<string, Record<string, number | null>>;

export type Tier = keyof typeof TIERS;
export const DEFAULT_TIER: Tier = "free";

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && Object.hasOwn(TIERS, value);
}

export function dailyLimit(tier: Tier, provider: string): number | null {
  const limits: Record<string, number | null> = TIERS[tier];
  return Object.hasOwn(limits, provider) ? limits[provider] : 0;
}

// Non-billable calls (polling, model lists) are rate limited instead of metered.
export const FREE_CALLS_PER_HOUR = 600;
// New device registrations allowed per IP per day.
export const REGISTRATIONS_PER_IP_PER_DAY = 10;
