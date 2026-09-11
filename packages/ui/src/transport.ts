/**
 * Transport: everything the UI needs from a host, behind one interface.
 *
 * `HttpTransport` talks to the standalone Bun host over fetch + WebSocket.
 * An embedder (e.g. t3code) can implement `Transport` over its own RPC and
 * pass it to `<PlanPresenter transport={...} />`.
 */

import type {
  CompiledPage,
  CreateFeedback,
  Feedback,
  LiveEvent,
  ReviewerPublic,
  SessionSummary,
  ReportRenderError,
  UpdateFeedback,
  UpdateSession,
} from "@plan-presenter/protocol";

export interface Transport {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionSummary>;
  updateSession(id: string, patch: UpdateSession): Promise<SessionSummary>;
  getPage(id: string, pageId: string): Promise<CompiledPage>;
  listFeedback(id: string, pageId?: string): Promise<Feedback[]>;
  createFeedback(id: string, input: CreateFeedback): Promise<Feedback>;
  updateFeedback(id: string, feedbackId: string, patch: UpdateFeedback): Promise<Feedback>;
  deleteFeedback(id: string, feedbackId: string): Promise<void>;
  reply(id: string, feedbackId: string, body: string): Promise<Feedback>;
  /** "Send to agent": batch all pending feedback (a reviewer's token sends only theirs). */
  send(id: string): Promise<{ batch: number; items: Feedback[] }>;
  /**
   * The invited reviewer this transport speaks for, or null on the owner path
   * (no invite token). See `pp invite`.
   */
  me(id: string): Promise<ReviewerPublic | null>;
  renameReviewer(id: string, reviewerId: string, name: string): Promise<ReviewerPublic>;
  /** Reviewer says they are done, even with nothing to send; wakes `pp wait`. */
  submitReview(id: string, reviewerId: string): Promise<ReviewerPublic>;
  openPath(id: string, path: string): Promise<{ action: string; path: string }>;
  /** Report a viewer-side render failure; the host forwards it to the agent. */
  reportError(id: string, input: ReportRenderError): Promise<void>;
  /** URL the browser can load session-relative files from (assets, data). */
  fileUrl(id: string, relPath: string): string;
  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(listener: (event: LiveEvent) => void): () => void;
  /** Connection status for the status pill. */
  onStatus(listener: (connected: boolean) => void): () => void;
}

/** Health poll cadence while connected, and how long a poll may take. */
const HEARTBEAT_MS = 4_000;
const HEARTBEAT_TIMEOUT_MS = 2_500;

export class TransportError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpTransportOptions {
  /** e.g. "" (same origin) or "http://192.168.1.10:27411". */
  baseUrl?: string;
  /**
   * Invite token from a `pp invite` link (`?reviewer=<token>`). Sent as
   * `X-PP-Reviewer` on every request so the host stamps feedback with the
   * reviewer and limits edits to their own items.
   */
  reviewerToken?: string;
}

export class HttpTransport implements Transport {
  private base: string;
  private reviewerToken: string | undefined;
  private listeners = new Set<(e: LiveEvent) => void>();
  private statusListeners = new Set<(c: boolean) => void>();
  private ws: WebSocket | null = null;
  private connected = false;
  private retry = 500;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private onVisible = () => {
    if (document.visibilityState === "visible") void this.checkHealth();
  };

  constructor(opts: HttpTransportOptions = {}) {
    this.base = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.reviewerToken = opts.reviewerToken || undefined;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(this.reviewerToken && { "x-pp-reviewer": this.reviewerToken }),
          ...init?.headers,
        },
      });
    } catch (err) {
      // Network-level failure (host down, DNS, CORS): status 0 so callers can
      // tell "unreachable" apart from an application error.
      this.setConnected(false);
      throw new TransportError(`the host cannot be reached (${(err as Error).message})`, 0);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* ignore */
      }
      throw new TransportError(msg, res.status);
    }
    return (await res.json()) as T;
  }

  listSessions() {
    return this.req<SessionSummary[]>("/api/sessions");
  }
  getSession(id: string) {
    return this.req<SessionSummary>(`/api/sessions/${enc(id)}`);
  }
  updateSession(id: string, patch: UpdateSession) {
    return this.req<SessionSummary>(`/api/sessions/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  getPage(id: string, pageId: string) {
    return this.req<CompiledPage>(`/api/sessions/${enc(id)}/pages/${enc(pageId)}`);
  }
  listFeedback(id: string, pageId?: string) {
    const q = pageId ? `?pageId=${enc(pageId)}` : "";
    return this.req<Feedback[]>(`/api/sessions/${enc(id)}/feedback${q}`);
  }
  createFeedback(id: string, input: CreateFeedback) {
    return this.req<Feedback>(`/api/sessions/${enc(id)}/feedback`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateFeedback(id: string, feedbackId: string, patch: UpdateFeedback) {
    return this.req<Feedback>(`/api/sessions/${enc(id)}/feedback/${enc(feedbackId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async deleteFeedback(id: string, feedbackId: string) {
    await this.req(`/api/sessions/${enc(id)}/feedback/${enc(feedbackId)}`, { method: "DELETE" });
  }
  reply(id: string, feedbackId: string, body: string) {
    return this.req<Feedback>(`/api/sessions/${enc(id)}/feedback/${enc(feedbackId)}/replies`, {
      method: "POST",
      body: JSON.stringify({ author: "human", body }),
    });
  }
  send(id: string) {
    return this.req<{ batch: number; items: Feedback[] }>(`/api/sessions/${enc(id)}/send`, {
      method: "POST",
    });
  }
  async me(id: string) {
    if (!this.reviewerToken) return null;
    return this.req<ReviewerPublic>(`/api/sessions/${enc(id)}/reviewers/me`);
  }
  renameReviewer(id: string, reviewerId: string, name: string) {
    return this.req<ReviewerPublic>(`/api/sessions/${enc(id)}/reviewers/${enc(reviewerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
  submitReview(id: string, reviewerId: string) {
    return this.req<ReviewerPublic>(
      `/api/sessions/${enc(id)}/reviewers/${enc(reviewerId)}/submit`,
      { method: "POST" },
    );
  }
  openPath(id: string, path: string) {
    return this.req<{ action: string; path: string }>("/api/open", {
      method: "POST",
      body: JSON.stringify({ sessionId: id, path }),
    });
  }
  async reportError(id: string, input: ReportRenderError) {
    await this.req(`/api/sessions/${enc(id)}/errors`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  fileUrl(id: string, relPath: string) {
    const clean = relPath.replace(/^\.?\//, "");
    return `${this.base}/api/sessions/${enc(id)}/files/${clean.split("/").map(enc).join("/")}`;
  }

  subscribe(listener: (e: LiveEvent) => void) {
    this.listeners.add(listener);
    this.ensureSocket();
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (c: boolean) => void) {
    this.statusListeners.add(listener);
    listener(this.connected);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private setConnected(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    for (const l of this.statusListeners) l(c);
  }

  /**
   * A crashed host closes the socket at once, but a hung one does not. Poll
   * /api/health while connected so "dead backend" shows within a few seconds;
   * a failed check drops the socket, which triggers the reconnect loop.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.checkHealth(), HEARTBEAT_MS);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/health`, {
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      return true;
    } catch {
      this.setConnected(false);
      this.ws?.close();
      return false;
    }
  }

  private ensureSocket() {
    if (this.ws || this.closed) return;
    const wsBase = this.base
      ? this.base.replace(/^http/, "ws")
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const ws = new WebSocket(`${wsBase}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.setConnected(true);
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(String(ev.data)) as LiveEvent;
        for (const l of this.listeners) l(event);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      this.setConnected(false);
      if (this.closed) return;
      const delay = this.retry;
      this.retry = Math.min(this.retry * 2, 4_000);
      setTimeout(() => this.ensureSocket(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
