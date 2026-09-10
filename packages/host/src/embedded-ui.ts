/**
 * Built UI files embedded into the compiled host binary.
 *
 * This committed file is a stub. `scripts/build-binaries.ts` overwrites it
 * with `import ... with { type: "file" }` lines for every file in
 * packages/ui/dist before running `bun build --compile`, then restores the
 * stub. In dev, the host serves the UI from disk instead.
 */
export const embeddedUi: Record<string, string> = {};
