import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const testEnv = {
  ...env,
  PANGRAM_API_KEY: { get: async () => "pangram-test-key" },
  TOKEN_SECRET: { get: async () => "test-token-secret" },
  ADMIN_SECRET: { get: async () => "test-admin" },
} as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let ipCounter = 0;

function call(path: string, init: RequestInit & { token?: string; admin?: boolean; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.admin) headers.set("authorization", "Bearer test-admin");
  headers.set("cf-connecting-ip", init.ip ?? `10.0.0.${++ipCounter}`);
  return worker.fetch(new Request(`https://gw.test${path}`, { ...init, headers }), testEnv, ctx);
}

async function register() {
  const res = await call("/v1/register", { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as { deviceId: string; token: string; tier: string };
}

const classify = (token: string) =>
  call("/v1/pangram/task", {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", model: "default" }),
  });

let upstream: ReturnType<typeof vi.fn>;
let taskCounter = 0;

beforeEach(() => {
  upstream = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/task") && init?.method === "POST") {
      return Response.json({ task_id: `task-${++taskCounter}` });
    }
    if (url.includes("/task/")) return Response.json({ stage: "STAGE_SUCCESS" });
    if (url.endsWith("/models")) return Response.json({ models: ["default"] });
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe("gateway", () => {
  it("rejects requests without a valid token", async () => {
    expect((await call("/v1/pangram/models")).status).toBe(401);
    const { token } = await register();
    const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect((await call("/v1/pangram/models", { token: forged })).status).toBe(401);
  });

  it("injects the upstream key and never exposes it", async () => {
    const { token } = await register();
    const res = await call("/v1/pangram/models", { token });
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://text.external-api.pangram.com/models");
    expect(new Headers(init.headers).get("x-api-key")).toBe("pangram-test-key");
    expect(await res.text()).not.toContain("pangram-test-key");
  });

  it("limits free devices to 3 classifications a day", async () => {
    const { token } = await register();
    for (let i = 2; i >= 0; i--) {
      const res = await classify(token);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Quota-Remaining")).toBe(String(i));
    }
    const blocked = await classify(token);
    expect(blocked.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("refunds quota when upstream fails", async () => {
    const { token } = await register();
    upstream.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const failed = await classify(token);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("X-Quota-Remaining")).toBe("3");
    expect((await classify(token)).headers.get("X-Quota-Remaining")).toBe("2");
  });

  it("only lets a device poll its own tasks", async () => {
    const a = await register();
    const b = await register();
    const { task_id } = (await (await classify(a.token)).json()) as { task_id: string };
    expect((await call(`/v1/pangram/task/${task_id}`, { token: a.token })).status).toBe(200);
    expect((await call(`/v1/pangram/task/${task_id}`, { token: b.token })).status).toBe(404);
  });

  it("blocks routes the provider doesn't allow", async () => {
    const { token } = await register();
    expect((await call("/v1/pangram/admin", { token })).status).toBe(404);
    expect((await call("/v1/nope/models", { token })).status).toBe(404);
  });

  it("lets admins upgrade and revoke devices", async () => {
    const { token, deviceId } = await register();
    expect((await call(`/admin/devices/${deviceId}`, { token })).status).toBe(401);

    const up = await call(`/admin/devices/${deviceId}`, {
      method: "PATCH",
      admin: true,
      body: JSON.stringify({ tier: "paid" }),
    });
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ tier: "paid" });
    expect((await classify(token)).headers.get("X-Quota-Remaining")).toBe("99");

    await call(`/admin/devices/${deviceId}`, { method: "PATCH", admin: true, body: JSON.stringify({ revoked: true }) });
    expect((await classify(token)).status).toBe(403);
  });

  it("rate limits registrations per IP", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call("/v1/register", { method: "POST", ip: "9.9.9.9" })).status).toBe(201);
    }
    expect((await call("/v1/register", { method: "POST", ip: "9.9.9.9" })).status).toBe(429);
  });
});
