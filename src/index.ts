import { Hono, type Context } from "hono";
import { PROVIDERS, matchRoute } from "./providers";
import { FREE_CALLS_PER_HOUR, REGISTRATIONS_PER_IP_PER_DAY, isTier, type Tier } from "./tiers";
import { safeEqual, signDeviceToken, verifyDeviceToken } from "./token";

export { Meter } from "./meter";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type App = { Bindings: Env; Variables: { deviceId: string } };
const app = new Hono<App>();

const meter = (env: Env, name: string) => env.METER.get(env.METER.idFromName(name));
const deviceMeter = (env: Env, deviceId: string) => meter(env, `device:${deviceId}`);

function error(c: Context, status: number, code: string, message: string, headers?: Record<string, string>) {
  return c.json({ error: { code, message } }, status as 400, headers);
}

function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

app.onError((err, c) => {
  console.error("unhandled", err);
  return error(c, 500, "internal", "Something went wrong");
});
app.notFound((c) => error(c, 404, "not_found", "No such route"));

app.get("/health", (c) => c.json({ ok: true }));

// ---- device registration ----

app.post("/v1/register", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const limit = await meter(c.env, `ip:${ip}`).hit("register", REGISTRATIONS_PER_IP_PER_DAY, DAY_MS);
  if (!limit.ok) return error(c, 429, "rate_limited", "Too many registrations from this network, try again later");

  const deviceId = crypto.randomUUID();
  const info = await deviceMeter(c.env, deviceId).register();
  const token = await signDeviceToken(deviceId, c.env.TOKEN_SECRET);
  return c.json({ deviceId, token, tier: info.tier }, 201);
});

// ---- device-authenticated routes ----

const v1 = new Hono<App>();

v1.use("*", async (c, next) => {
  const token = bearer(c);
  const deviceId = token && (await verifyDeviceToken(token, c.env.TOKEN_SECRET));
  if (!deviceId) return error(c, 401, "unauthorized", "Missing or invalid device token");
  c.set("deviceId", deviceId);
  await next();
});

v1.get("/me", async (c) => {
  const stub = deviceMeter(c.env, c.get("deviceId"));
  const info = await stub.info();
  if (!info) return error(c, 401, "unauthorized", "Unknown device");
  return c.json({ deviceId: c.get("deviceId"), ...info, usageToday: await stub.usage() });
});

v1.all("/:provider/*", async (c) => {
  const provider = PROVIDERS[c.req.param("provider")];
  if (!provider) return error(c, 404, "unknown_provider", "No such provider");

  const prefix = `/v1/${provider.id}`;
  const path = c.req.path.slice(prefix.length);
  const match = matchRoute(provider, c.req.method, path);
  if (!match) return error(c, 404, "not_found", "Route not available through this gateway");
  const { route, params } = match;

  const deviceId = c.get("deviceId");
  const stub = deviceMeter(c.env, deviceId);
  const info = await stub.info();
  if (!info) return error(c, 401, "unauthorized", "Unknown device");
  if (info.revoked) return error(c, 403, "revoked", "This device has been disabled");

  let body: ArrayBuffer | undefined;
  if (route.method === "POST") {
    body = await c.req.arrayBuffer();
    if (route.maxBodyBytes && body.byteLength > route.maxBodyBytes) {
      return error(c, 413, "too_large", "Request body too large");
    }
  }

  if (route.ownership === "require" && !(await stub.ownsTask(provider.id, params[0]))) {
    return error(c, 404, "not_found", "No such task");
  }

  // Charge before calling upstream so concurrent requests can't overspend.
  const quotaHeaders: Record<string, string> = {};
  let charged: { day: string } | undefined;
  if (route.cost > 0) {
    const quota = await stub.consume(provider.id, route.cost);
    quotaHeaders["X-Quota-Limit"] = String(quota.limit);
    quotaHeaders["X-Quota-Remaining"] = String(quota.remaining);
    quotaHeaders["X-Quota-Reset"] = new Date(quota.resetAt).toISOString();
    if (!quota.ok) {
      return error(c, 429, "quota_exceeded", `Daily ${provider.id} quota used up`, {
        ...quotaHeaders,
        "Retry-After": String(Math.ceil((quota.resetAt - Date.now()) / 1000)),
      });
    }
    const cap = Number(c.env.GLOBAL_DAILY_CAP) || 0;
    const global = await meter(c.env, "global").hit(`daily:${provider.id}`, cap, DAY_MS, route.cost);
    if (!global.ok) {
      await stub.refund(provider.id, route.cost, quota.day);
      return error(c, 503, "capacity", "Service is at capacity for today, try again tomorrow");
    }
    charged = { day: quota.day };
  } else {
    const limit = await stub.hit("free", FREE_CALLS_PER_HOUR, HOUR_MS);
    if (!limit.ok) return error(c, 429, "rate_limited", "Slow down");
  }

  const refund = async () => {
    if (!charged) return;
    await Promise.all([
      stub.refund(provider.id, route.cost, charged.day),
      meter(c.env, "global").unhit(`daily:${provider.id}`, DAY_MS, route.cost),
    ]);
    quotaHeaders["X-Quota-Remaining"] = String(Number(quotaHeaders["X-Quota-Remaining"]) + route.cost);
  };

  const secret = (c.env as unknown as Record<string, SecretsStoreSecret>)[provider.secretBinding];
  const headers = new Headers();
  provider.applyAuth(headers, await secret.get());
  if (body) headers.set("content-type", c.req.header("content-type") ?? "application/json");

  let upstream: Response;
  try {
    upstream = await fetch(provider.baseUrl + route.upstream(...params), {
      method: route.method,
      headers,
      body,
    });
  } catch (err) {
    console.error("upstream fetch failed", provider.id, err);
    await refund();
    return error(c, 502, "upstream_unreachable", "Upstream service unreachable", quotaHeaders);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    await refund();
  } else if (route.ownership === "issue") {
    let taskId: string | undefined;
    try {
      taskId = route.taskIdFrom?.(JSON.parse(text));
    } catch {}
    if (taskId) await stub.addTask(provider.id, taskId);
  }

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...quotaHeaders,
    },
  });
});

app.route("/v1", v1);

// ---- admin ----

const admin = new Hono<App>();

admin.use("*", async (c, next) => {
  const token = bearer(c);
  if (!c.env.ADMIN_SECRET || !token || !safeEqual(token, c.env.ADMIN_SECRET)) {
    return error(c, 401, "unauthorized", "Admin token required");
  }
  await next();
});

admin.get("/devices/:id", async (c) => {
  const stub = deviceMeter(c.env, c.req.param("id"));
  const info = await stub.info();
  if (!info) return error(c, 404, "not_found", "No such device");
  return c.json({ deviceId: c.req.param("id"), ...info, usageToday: await stub.usage() });
});

admin.patch("/devices/:id", async (c) => {
  const body = await c.req.json<{ tier?: unknown; revoked?: unknown }>().catch(() => ({}) as never);
  const patch: { tier?: Tier; revoked?: boolean } = {};
  if (body.tier !== undefined) {
    if (!isTier(body.tier)) return error(c, 400, "bad_tier", "Unknown tier");
    patch.tier = body.tier;
  }
  if (body.revoked !== undefined) {
    if (typeof body.revoked !== "boolean") return error(c, 400, "bad_revoked", "revoked must be boolean");
    patch.revoked = body.revoked;
  }
  const info = await deviceMeter(c.env, c.req.param("id")).update(patch);
  if (!info) return error(c, 404, "not_found", "No such device");
  return c.json({ deviceId: c.req.param("id"), ...info });
});

app.route("/admin", admin);

export default app satisfies ExportedHandler<Env>;
