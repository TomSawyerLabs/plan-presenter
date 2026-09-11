import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, type Host } from "../src/app.ts";

// Regression: Hono hands each WebSocket event a fresh wrapper, so a client
// tagged on open was never found again on close. Closed viewers stayed in the
// set forever and the auto-updater never saw the host as idle.

let host: Host;
let root: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pp-ws-"));
  host = await createHost({ root });
  server = Bun.serve({ port: 0, fetch: host.app.fetch, websocket: host.websocket });
});

afterAll(async () => {
  server.stop(true);
  await host.stop();
  rmSync(root, { recursive: true, force: true });
});

async function viewers(): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  return ((await res.json()) as { activity: { clients: number } }).activity.clients;
}

async function eventually(want: number, ms = 3000): Promise<number> {
  let got = await viewers();
  for (const end = Date.now() + ms; got !== want && Date.now() < end;) {
    await Bun.sleep(25);
    got = await viewers();
  }
  return got;
}

test("viewer connections are counted and released when they close", async () => {
  expect(await viewers()).toBe(0);
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    return new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = reject;
    });
  };
  const [a, b] = await Promise.all([open(), open()]);
  expect(await eventually(2)).toBe(2);
  a.close();
  expect(await eventually(1)).toBe(1);
  b.close();
  expect(await eventually(0)).toBe(0);
});
