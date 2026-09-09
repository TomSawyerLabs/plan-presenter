/**
 * Standalone app: hash routing over the session list and session view.
 *   #/                 sessions
 *   #/s/<id>           session (first page)
 *   #/s/<id>/<pageId>  session at page
 */

import { useCallback, useEffect, useState } from "react";
import { SessionList } from "./components/SessionList.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { SessionProvider } from "./state.tsx";
import type { Transport } from "./transport.ts";

interface Route {
  sessionId: string | null;
  pageId: string | null;
}

function parseHash(): Route {
  const m = /^#\/s\/([^/]+)(?:\/([^/]+))?/.exec(location.hash);
  return { sessionId: m?.[1] ? decodeURIComponent(m[1]) : null, pageId: m?.[2] ? decodeURIComponent(m[2]) : null };
}

export function App({ transport }: { transport: Transport }) {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((sessionId: string | null, pageId?: string | null) => {
    location.hash = sessionId ? `#/s/${encodeURIComponent(sessionId)}${pageId ? `/${encodeURIComponent(pageId)}` : ""}` : "#/";
  }, []);

  if (!route.sessionId) return <SessionList transport={transport} onOpen={(id) => go(id)} />;

  return (
    <SessionProvider
      key={route.sessionId}
      transport={transport}
      sessionId={route.sessionId}
      pageId={route.pageId}
      onPageChange={(pid) => go(route.sessionId, pid)}
    >
      <SessionView onBack={() => go(null)} />
    </SessionProvider>
  );
}
