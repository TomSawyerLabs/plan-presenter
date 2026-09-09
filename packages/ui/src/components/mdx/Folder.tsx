/**
 * <Folder path="C:/repo/src"> - opens a local folder (or reveals a file) in the
 * OS file manager via the host. Only works when the host runs on the machine
 * that owns the path and the path is inside the session's allowed roots.
 */

import { useState, type ReactNode } from "react";
import { useSessionOptional } from "../../state.tsx";

export interface FolderProps {
  path: string;
  children?: ReactNode;
  [attr: `data-${string}`]: string | undefined;
}

export function Folder(props: FolderProps) {
  const { path, children } = props;
  const session = useSessionOptional();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const dataAttrs = Object.fromEntries(
    Object.entries(props).filter(([k]) => k.startsWith("data-")),
  );

  const open = async () => {
    if (!session) return setStatus({ ok: false, text: "No host connection" });
    try {
      await session.openPath(path);
      setStatus({ ok: true, text: "Opened on host" });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
    setTimeout(() => setStatus(null), 4000);
  };

  return (
    <span className="pp-folder" data-pp-interactive="" {...dataAttrs}>
      <button type="button" className="pp-folder-button" onClick={open}>
        <span aria-hidden="true">📁</span> {children ?? <code>{path}</code>}
      </button>
      {children != null && <code className="pp-folder-path">{path}</code>}
      {status && (
        <span className={status.ok ? "pp-status-ok" : "pp-status-err"}>{status.text}</span>
      )}
    </span>
  );
}

/** True for hrefs that mean "open this on the host machine". */
export function isLocalPathHref(href: string): boolean {
  return (
    /^(file|folder|path):/i.test(href) ||
    /^[A-Za-z]:[\\/]/.test(href) ||
    (href.startsWith("/") &&
      !href.startsWith("//") &&
      /^\/(Users|home|mnt|opt|srv|var|tmp|etc)\b/.test(href))
  );
}

/** Turn `file:///C:/x`, `folder://C:/x`, `path:C:/x` into a plain path. */
export function hrefToPath(href: string): string {
  let p = href.replace(/^(folder|path):(\/\/)?/i, "").replace(/^file:\/\/\/?/i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  // file:///C:/x -> C:/x ; file://localhost/C:/x -> C:/x
  p = p.replace(/^localhost\//, "");
  return p;
}
