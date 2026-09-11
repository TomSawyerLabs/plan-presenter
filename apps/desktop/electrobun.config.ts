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
    version: "0.2.0",
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
  release: {
    // The updater fetches `${baseUrl}/<channel>-<os>-<arch>-update.json`, then a
    // bsdiff patch from the running build's hash or the full tarball. GitHub's
    // latest/download redirect always points at the newest release, whose
    // assets release.yml uploads. Stable builds also diff against that release
    // at build time to produce the patch; canary (CI) builds find nothing and
    // skip it.
    baseUrl: "https://github.com/TomSawyerLabs/plan-presenter/releases/latest/download",
    generatePatch: true,
  },
} satisfies ElectrobunConfig;
