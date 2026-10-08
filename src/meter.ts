import { DurableObject } from "cloudflare:workers";
import { DEFAULT_TIER, dailyLimit, type Tier } from "./tiers";

export interface DeviceInfo {
  tier: Tier;
  revoked: boolean;
  createdAt: number;
}

export interface QuotaResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms
  day: string;
}

export interface HitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now = Date.now()): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
}

/**
 * One instance per device ("device:<id>"), plus shared instances for the
 * global cap ("global") and per-IP registration limits ("ip:<addr>").
 * Each instance is single-threaded, so read-modify-write here is atomic.
 */
export class Meter extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage.kv;
  }

  // ---- device lifecycle ----

  register(): DeviceInfo {
    const existing = this.kv.get<DeviceInfo>("device");
    if (existing) return existing;
    const info: DeviceInfo = { tier: DEFAULT_TIER, revoked: false, createdAt: Date.now() };
    this.kv.put("device", info);
    return info;
  }

  info(): DeviceInfo | null {
    return this.kv.get<DeviceInfo>("device") ?? null;
  }

  update(patch: Partial<Pick<DeviceInfo, "tier" | "revoked">>): DeviceInfo | null {
    const info = this.info();
    if (!info) return null;
    const next = { ...info, ...patch };
    this.kv.put("device", next);
    return next;
  }

  // ---- daily quota ----

  consume(provider: string, cost: number): QuotaResult {
    const info = this.info();
    const now = Date.now();
    const day = utcDay(now);
    const limit = info && !info.revoked ? dailyLimit(info.tier, provider) : 0;
    const key = `usage:${provider}:${day}`;
    const used = this.kv.get<number>(key) ?? 0;
    const resetAt = nextUtcMidnight(now);

    if (used + cost > limit) {
      return { ok: false, limit, remaining: Math.max(0, limit - used), resetAt, day };
    }
    this.kv.put(key, used + cost);
    this.pruneUsage(provider, day);
    return { ok: true, limit, remaining: limit - used - cost, resetAt, day };
  }

  refund(provider: string, cost: number, day: string): void {
    const key = `usage:${provider}:${day}`;
    const used = this.kv.get<number>(key) ?? 0;
    this.kv.put(key, Math.max(0, used - cost));
  }

  usage(): Record<string, number> {
    const day = utcDay();
    const out: Record<string, number> = {};
    for (const [key, value] of this.kv.list<number>({ prefix: "usage:" })) {
      const [, provider, d] = key.split(":");
      if (d === day) out[provider] = value;
    }
    return out;
  }

  private pruneUsage(provider: string, today: string): void {
    for (const [key] of this.kv.list({ prefix: `usage:${provider}:` })) {
      if (!key.endsWith(today)) this.kv.delete(key);
    }
  }

  // ---- fixed-window counters (global cap, rate limits) ----

  hit(name: string, max: number, windowMs: number, cost = 1): HitResult {
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const key = `hit:${name}`;
    const state = this.kv.get<{ window: number; count: number }>(key);
    const count = state?.window === window ? state.count : 0;
    const resetAt = (window + 1) * windowMs;
    if (count + cost > max) return { ok: false, remaining: Math.max(0, max - count), resetAt };
    this.kv.put(key, { window, count: count + cost });
    return { ok: true, remaining: max - count - cost, resetAt };
  }

  unhit(name: string, windowMs: number, cost = 1): void {
    const window = Math.floor(Date.now() / windowMs);
    const key = `hit:${name}`;
    const state = this.kv.get<{ window: number; count: number }>(key);
    if (state?.window === window) this.kv.put(key, { window, count: Math.max(0, state.count - cost) });
  }

  // ---- task ownership ----

  addTask(provider: string, taskId: string): void {
    const now = Date.now();
    this.kv.put(`task:${provider}:${taskId}`, now + TASK_TTL_MS);
    for (const [key, expires] of this.kv.list<number>({ prefix: "task:" })) {
      if (expires < now) this.kv.delete(key);
    }
  }

  ownsTask(provider: string, taskId: string): boolean {
    const expires = this.kv.get<number>(`task:${provider}:${taskId}`);
    return expires !== undefined && expires > Date.now();
  }
}
