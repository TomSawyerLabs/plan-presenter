/**
 * Minimal typings for the slice of Electrobun 1.18 we use. Electrobun ships
 * its Bun API as raw .ts under dist/, which drags its own (currently failing)
 * type errors into our typecheck; mapping the module here keeps our check
 * about our code. Runtime resolution is untouched (bundler uses the real
 * package); only `tsc` sees this file via tsconfig `paths`.
 */

declare module "electrobun/bun" {
  export interface BrowserWindowFrame {
    width: number;
    height: number;
    x: number;
    y: number;
  }
  export interface BrowserWindowOptions {
    title?: string;
    url?: string | null;
    html?: string | null;
    preload?: string | null;
    frame?: Partial<BrowserWindowFrame>;
    renderer?: "native" | "cef";
    titleBarStyle?: "hidden" | "hiddenInset" | "default";
    transparent?: boolean;
    hidden?: boolean;
    navigationRules?: string | null;
    sandbox?: boolean;
  }
  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    on(
      event: "close" | "resize" | "move" | "focus" | "blur",
      handler: (...args: unknown[]) => void,
    ): void;
    close(): void;
    focus(): void;
    setTitle(title: string): void;
  }
  export const Utils: {
    openExternal(url: string): boolean;
    openPath(path: string): boolean;
    showItemInFolder(path: string): boolean;
    quit(): void;
  };
}

declare module "electrobun" {
  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
      description?: string;
      urlSchemes?: string[];
    };
    build?: {
      buildFolder?: string;
      artifactFolder?: string;
      bun?: { entrypoint: string };
      views?: Record<string, { entrypoint: string; [key: string]: unknown }>;
      copy?: Record<string, string>;
      watch?: string[];
      watchIgnore?: string[];
      mac?: {
        bundleCEF?: boolean;
        codesign?: boolean;
        notarize?: boolean;
        createDmg?: boolean;
        icons?: string;
      };
      win?: { bundleCEF?: boolean; icon?: string };
      linux?: { bundleCEF?: boolean; icon?: string };
    };
    scripts?: { preBuild?: string; postBuild?: string; postWrap?: string; postPackage?: string };
    release?: { baseUrl?: string; generatePatch?: boolean };
  }
}
