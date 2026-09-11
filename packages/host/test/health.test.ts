import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, type Host } from "../src/app.ts";

let host: Host;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pp-health-"));
  host = await createHost({ root });
});

afterAll(async () => {
  await host.stop();
  rmSync(root, { recursive: true, force: true });
});

test("health reports identity and activity for the auto-updater", async () => {
  const h = (await (await host.app.request("/api/health")).json()) as Record<string, unknown>;
  expect(h.pid).toBe(process.pid);
  expect(h.execPath).toBe(process.execPath);
  expect(typeof h.startedAt).toBe("string");
  expect(h.activity).toEqual({ clients: 0, waiters: 0, lastRequestAt: null });

  // Health polling itself must not count as activity; real API calls do.
  await host.app.request("/api/health");
  const h1 = (await (await host.app.request("/api/health")).json()) as {
    activity: { lastRequestAt: string | null };
  };
  expect(h1.activity.lastRequestAt).toBeNull();
  await host.app.request("/api/sessions");
  const h2 = (await (await host.app.request("/api/health")).json()) as {
    activity: { lastRequestAt: string | null };
  };
  expect(typeof h2.activity.lastRequestAt).toBe("string");
});
