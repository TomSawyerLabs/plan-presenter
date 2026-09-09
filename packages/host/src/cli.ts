#!/usr/bin/env bun
/**
 * pp-host: run the plan-presenter host.
 *
 *   pp-host [--port 27411] [--host 127.0.0.1|0.0.0.0] [--root ~/.plan-presenter/sessions] [--ui <dir>]
 *
 * `--host 0.0.0.0` exposes the UI on the LAN (no auth: see README).
 */

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_PORT } from "@plan-presenter/protocol";
import { createHost } from "./app.ts";

export function defaultRoot(): string {
  return process.env.PP_ROOT ?? join(homedir(), ".plan-presenter", "sessions");
}

export function defaultUiDir(): string | undefined {
  const candidates = [
    process.env.PP_UI_DIR,
    resolve(import.meta.dir, "../../ui/dist"),
    resolve(import.meta.dir, "../ui"),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p", default: String(process.env.PP_PORT ?? DEFAULT_PORT) },
      host: { type: "string", short: "H", default: process.env.PP_HOST ?? "127.0.0.1" },
      root: { type: "string", short: "r", default: defaultRoot() },
      ui: { type: "string", default: defaultUiDir() },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pp-host [--port N] [--host 127.0.0.1|0.0.0.0] [--root DIR] [--ui DIR]\n\n" +
        "  --host 0.0.0.0   listen on all interfaces (LAN access, no auth)\n" +
        "  --root DIR       sessions directory (default ~/.plan-presenter/sessions)\n" +
        "  --ui DIR         built UI directory (default: packages/ui/dist)\n",
    );
    return;
  }

  const host = await createHost({ root: resolve(values.root!), uiDir: values.ui });
  const server = Bun.serve({
    port: Number(values.port),
    hostname: values.host,
    fetch: host.app.fetch,
    websocket: host.websocket,
    idleTimeout: 255,
  });

  const url = `http://${values.host === "0.0.0.0" ? "localhost" : values.host}:${server.port}`;
  console.log(`plan-presenter host ${url}  (sessions: ${host.store.root})`);
  if (!values.ui) console.log("no built UI found: run `bun run build` or use `bun run dev:ui`");

  const shutdown = async () => {
    await host.stop();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
