/**
 * Session state: one context that holds the transport, the current session,
 * its pages, feedback, and the live-event plumbing. Kept deliberately small
 * (no external state library) so it embeds cleanly anywhere.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CompiledPage,
  CreateFeedback,
  Feedback,
  LiveEvent,
  SessionSummary,
  UpdateFeedback,
} from "@plan-presenter/protocol";
import type { Transport } from "./transport.ts";

export interface SessionState {
  transport: Transport;
  connected: boolean;
  session: SessionSummary | null;
  pages: Map<string, CompiledPage>;
  currentPageId: string | null;
  page: CompiledPage | null;
  feedback: Feedback[];
  loading: boolean;
  error: string | null;
  /** Bumped whenever an asset in the session changes; media components re-fetch. */
  assetVersion: number;
  setCurrentPage: (pageId: string) => void;
  createFeedback: (input: CreateFeedback) => Promise<Feedback>;
  updateFeedback: (id: string, patch: UpdateFeedback) => Promise<Feedback>;
  deleteFeedback: (id: string) => Promise<void>;
  reply: (id: string, body: string) => Promise<Feedback>;
  send: () => Promise<{ batch: number; items: Feedback[] }>;
  openPath: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession must be used inside <SessionProvider>");
  return s;
}

export function useSessionOptional(): SessionState | null {
  return useContext(Ctx);
}

export interface SessionProviderProps {
  transport: Transport;
  sessionId: string;
  /** Controlled page selection (e.g. from the URL); uncontrolled if omitted. */
  pageId?: string | null;
  onPageChange?: (pageId: string) => void;
  onError?: (err: unknown) => void;
  children: ReactNode;
}

export function SessionProvider({ transport, sessionId, pageId, onPageChange, onError, children }: SessionProviderProps) {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [pages, setPages] = useState<Map<string, CompiledPage>>(new Map());
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [uncontrolledPage, setUncontrolledPage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const pageIdRef = useRef<string | null>(null);

  const currentPageId = pageId !== undefined ? pageId : uncontrolledPage;
  pageIdRef.current = currentPageId;

  const setCurrentPage = useCallback(
    (id: string) => {
      setUncontrolledPage(id);
      onPageChange?.(id);
    },
    [onPageChange],
  );

  const fail = useCallback(
    (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      onError?.(err);
    },
    [onError],
  );

  const loadSession = useCallback(async () => {
    const s = await transport.getSession(sessionId);
    setSession(s);
    return s;
  }, [transport, sessionId]);

  const loadPage = useCallback(
    async (pid: string) => {
      const p = await transport.getPage(sessionId, pid);
      setPages((prev) => {
        const next = new Map(prev);
        next.set(pid, p);
        return next;
      });
      return p;
    },
    [transport, sessionId],
  );

  const loadFeedback = useCallback(async () => {
    setFeedback(await transport.listFeedback(sessionId));
  }, [transport, sessionId]);

  const refresh = useCallback(async () => {
    try {
      const s = await loadSession();
      await loadFeedback();
      const ids = s.pageSummaries.map((p) => p.id);
      setPages((prev) => {
        const next = new Map();
        for (const id of ids) if (prev.has(id)) next.set(id, prev.get(id));
        return next;
      });
      const wanted = pageIdRef.current && ids.includes(pageIdRef.current) ? pageIdRef.current : ids[0] ?? null;
      if (wanted) {
        if (wanted !== pageIdRef.current) setCurrentPage(wanted);
        await loadPage(wanted);
      }
      setError(null);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [loadSession, loadFeedback, loadPage, setCurrentPage, fail]);

  // Initial load + reload when the session id changes.
  useEffect(() => {
    setLoading(true);
    setPages(new Map());
    setFeedback([]);
    void refresh();
  }, [refresh]);

  // Load a page when it becomes current and isn't cached.
  useEffect(() => {
    if (currentPageId && !pages.has(currentPageId) && session?.pageSummaries.some((p) => p.id === currentPageId)) {
      loadPage(currentPageId).catch(fail);
    }
  }, [currentPageId, pages, session, loadPage, fail]);

  // Live events.
  useEffect(() => transport.onStatus(setConnected), [transport]);
  useEffect(() => {
    let wasConnected = false;
    const offStatus = transport.onStatus((c) => {
      if (c && wasConnected === false) void refresh(); // catch up after (re)connect
      wasConnected = c;
    });
    const off = transport.subscribe((e: LiveEvent) => {
      if (!("sessionId" in e) || e.sessionId !== sessionId) return;
      switch (e.type) {
        case "session.changed":
          loadSession().then(loadFeedback).catch(fail);
          break;
        case "session.removed":
          setSession(null);
          setError("This session was removed.");
          break;
        case "page.changed":
          loadSession().catch(fail);
          if (pageIdRef.current === e.pageId) loadPage(e.pageId).catch(fail);
          else setPages((prev) => {
            const next = new Map(prev);
            next.delete(e.pageId);
            return next;
          });
          break;
        case "page.removed":
          setPages((prev) => {
            const next = new Map(prev);
            next.delete(e.pageId);
            return next;
          });
          loadSession().catch(fail);
          break;
        case "asset.changed":
          setAssetVersion((v) => v + 1);
          break;
        case "feedback.changed":
        case "feedback.batch":
          loadFeedback().catch(fail);
          loadSession().catch(fail);
          break;
      }
    });
    return () => {
      off();
      offStatus();
    };
  }, [transport, sessionId, loadSession, loadFeedback, loadPage, refresh, fail]);

  const value = useMemo<SessionState>(
    () => ({
      transport,
      connected,
      session,
      pages,
      currentPageId,
      page: currentPageId ? pages.get(currentPageId) ?? null : null,
      feedback,
      loading,
      error,
      assetVersion,
      setCurrentPage,
      createFeedback: async (input) => {
        const f = await transport.createFeedback(sessionId, input);
        setFeedback((prev) => (prev.some((x) => x.id === f.id) ? prev : [...prev, f]));
        return f;
      },
      updateFeedback: async (id, patch) => {
        const f = await transport.updateFeedback(sessionId, id, patch);
        setFeedback((prev) => prev.map((x) => (x.id === id ? f : x)));
        return f;
      },
      deleteFeedback: async (id) => {
        await transport.deleteFeedback(sessionId, id);
        setFeedback((prev) => prev.filter((x) => x.id !== id));
      },
      reply: async (id, body) => {
        const f = await transport.reply(sessionId, id, body);
        setFeedback((prev) => prev.map((x) => (x.id === id ? f : x)));
        return f;
      },
      send: async () => {
        const r = await transport.send(sessionId);
        await loadFeedback();
        await loadSession();
        return r;
      },
      openPath: async (path) => {
        await transport.openPath(sessionId, path);
      },
      refresh,
    }),
    [transport, connected, session, pages, currentPageId, feedback, loading, error, assetVersion, setCurrentPage, sessionId, loadFeedback, loadSession, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
