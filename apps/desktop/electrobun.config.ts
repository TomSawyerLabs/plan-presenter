import type { ElectrobunConfig } from "electrobun";

/**
 * Desktop shell. The Bun main process (src/bun/index.ts) runs the host
 * in-process and opens a native window on it. The built web UI is copied
 * into the bundle under views/ui and served by that host.
 *
 * Build the UI first: `bun run build` at the repo root.
 */
export default {
  app: {
    name: "plan-presenter",
    identifier: "com.tacklind.plan-presenter",
    version: "0.0.0",
    description: "Agents present plans; humans click to give feedback.",
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      "../../packages/ui/dist": "views/ui",
    },
    watchIgnore: ["../../packages/ui/dist/**"],
    mac: { bundleCEF: false },
    win: { bundleCEF: false },
    linux: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
