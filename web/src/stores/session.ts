/**
 * Pinia store (Task 18): sessions list, active session's folded event
 * state, and every mutating action (`send`, `reconnect`, `confirm`,
 * `cancel`) the UI drives. All server I/O for the chat lives here —
 * components read state/getters and call actions, nothing else talks to
 * `fetch` directly.
 */

import { defineStore } from 'pinia';
import { fetchSse, SseHttpError } from '../lib/sse.js';
import { applyEvent, emptyChatState, type SessionChatState } from '../lib/fold.js';
import { normalizeEvent, type AppEvent } from '../lib/events.js';
import type { Span } from '../lib/trace.js';

export interface SessionSummary {
  id: string;
  title: string | null;
  updated_at: number;
  turns: number;
  cost_usd: number;
}

/** A selectable model tier from GET /api/models (mirrors the server's
 * SelectableModel). */
export interface ModelOption {
  id: string;
  tier: string;
  label: string;
  name: string;
  description: string;
  provider: string;
  streamsTools: boolean;
  speed: number;
  intelligence: number;
  recommended?: boolean;
}

/** One entry from the full OpenRouter catalog (advanced "other models"). */
export interface CatalogModel {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
}

/** Sidebar page size. The DB can hold hundreds of eval-generated sessions;
 * we render the newest page and reveal older ones on demand via the
 * cursor-based `GET /api/sessions?limit&cursor` the server already supports
 * (cursor = id of the last row currently shown). */
const SESSIONS_PAGE_SIZE = 30;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
/** Hard ceiling on how long a SINGLE reconnect attempt's `GET .../stream`
 * request is allowed to sit open with no frame arriving. Without this, a
 * stream that opens fine (200 OK) but then only ever sends heartbeats —
 * e.g. the server accepted the connection but the turn it's meant to
 * resume never produces another event (crashed mid-handler, or there is
 * genuinely nothing new to replay) — would hang the `for await` loop
 * forever: no exception, no timer, nothing for the attempt-counter/backoff
 * logic below to ever see. Aborting at this ceiling turns that silent hang
 * into a normal failed attempt, so it always counts toward
 * `MAX_RECONNECT_ATTEMPTS` and the loop can still bail with a manual-retry
 * banner — no path is allowed to spin forever. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000;
const TOAST_LIFETIME_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeSendFailure(err: unknown): string {
  if (err instanceof SseHttpError) return `Failed to send — the server returned HTTP ${err.status}.`;
  return 'Failed to send — could not reach the server.';
}

/** Task 19's `TraceView` per-turn span waterfall: on-demand fetch state for
 * `GET /api/traces/:turnId`, keyed by `turnId` so switching between turns
 * never re-fetches a trace already loaded. */
export interface TraceState {
  spans: Span[];
  loading: boolean;
  error: string | null;
}

/** The model choice persists across refreshes (localStorage). Guarded so a
 * non-browser/denied-storage environment degrades to the server default. */
const MODEL_STORAGE_KEY = 'ask-ai:selectedModel';
function readStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeStoredModel(id: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — selection just won't persist this session */
  }
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as SessionSummary[],
    activeId: null as string | null,
    chats: {} as Record<string, SessionChatState>,
    traces: {} as Record<string, TraceState>,
    /** Set when the app can't even load the session list — drives the
     * app-level "server unreachable" retry screen (distinct from a
     * per-session SSE-drop banner, which uses `chat.error`). */
    serverUnreachable: false,
    /** Set when a directly-loaded `/s/:id` (or a stale link) names a session
     * the server returns 404 for — drives the "session not found" empty
     * state. Distinct from `serverUnreachable` (a network/transport failure):
     * a 404 is a definitive "no such session", not "can't reach the server". */
    sessionNotFound: false,
    /** True when the last sessions page came back full — there may be older
     * sessions to reveal via `loadMoreSessions`. */
    sessionsHasMore: false,
    /** True while an older-sessions page is being fetched (drives the
     * "Show older" affordance's disabled/label state). */
    sessionsLoadingMore: false,
    toasts: [] as { id: number; text: string }[],
    toastSeq: 0,
    /** Model-picker: the tier allowlist from GET /api/models and the id the
     * user has chosen (sent with each message; '' = server default). */
    models: [] as ModelOption[],
    /** The "Auto" option (server picks a tier per question), kept out of the
     * tier slider and shown as a separate pill. Null until /api/models loads. */
    autoModel: null as ModelOption | null,
    /** Restored from localStorage so a refresh keeps the user's choice. */
    selectedModel: readStoredModel(),
    /** Advanced picker: the full OpenRouter catalog (lazy-loaded on first open)
     * and whether a load is in flight. */
    catalog: [] as CatalogModel[],
    catalogLoading: false,
  }),

  getters: {
    activeChat(state): SessionChatState | null {
      return state.activeId ? state.chats[state.activeId] ?? null : null;
    },
  },

  actions: {
    pushToast(text: string): void {
      const id = this.toastSeq++;
      this.toasts.push({ id, text });
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, TOAST_LIFETIME_MS);
    },

    ensureChat(id: string): SessionChatState {
      if (!this.chats[id]) this.chats[id] = emptyChatState();
      return this.chats[id];
    },

    async loadModels(): Promise<void> {
      if (this.models.length > 0) return;
      try {
        const res = await fetch('/api/models');
        if (!res.ok) return;
        const body = (await res.json()) as { models: ModelOption[]; default: string };
        // Split "Auto" out of the tier slider — it's an adaptive meta-option.
        this.autoModel = body.models.find((m) => m.id === 'auto') ?? null;
        this.models = body.models.filter((m) => m.id !== 'auto');
        // Keep any restored/persisted choice; only fall back to the server
        // default when the user has never chosen one.
        if (this.selectedModel === '') this.selectedModel = body.default;
      } catch {
        /* non-fatal: the picker just stays empty and the server default applies */
      }
    },

    /** Set the active model AND persist it across refreshes. */
    selectModel(id: string): void {
      this.selectedModel = id;
      writeStoredModel(id);
    },

    async loadCatalog(): Promise<void> {
      if (this.catalog.length > 0 || this.catalogLoading) return;
      this.catalogLoading = true;
      try {
        const res = await fetch('/api/models/catalog');
        if (res.ok) this.catalog = ((await res.json()) as { models: CatalogModel[] }).models;
      } catch {
        /* non-fatal: the advanced list just stays empty */
      } finally {
        this.catalogLoading = false;
      }
    },

    async loadSessions(): Promise<void> {
      try {
        const res = await fetch(`/api/sessions?limit=${SESSIONS_PAGE_SIZE}`);
        if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
        const rows = (await res.json()) as SessionSummary[];
        this.sessions = rows;
        this.sessionsHasMore = rows.length === SESSIONS_PAGE_SIZE;
        this.serverUnreachable = false;
      } catch {
        this.serverUnreachable = true;
      }
    },

    /** Reveals the next page of older sessions (cursor = last-shown id),
     * appending to the current list. Best-effort: a failure surfaces a toast
     * and leaves the list as-is. */
    async loadMoreSessions(): Promise<void> {
      if (this.sessionsLoadingMore || !this.sessionsHasMore) return;
      const cursor = this.sessions.at(-1)?.id;
      if (!cursor) return;
      this.sessionsLoadingMore = true;
      try {
        const res = await fetch(`/api/sessions?limit=${SESSIONS_PAGE_SIZE}&cursor=${cursor}`);
        if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
        const rows = (await res.json()) as SessionSummary[];
        // Guard against the cursor row reappearing (id-stable paging already
        // excludes it, but dedupe defensively so a row can never double).
        const seen = new Set(this.sessions.map((s) => s.id));
        this.sessions = [...this.sessions, ...rows.filter((r) => !seen.has(r.id))];
        this.sessionsHasMore = rows.length === SESSIONS_PAGE_SIZE;
      } catch {
        this.pushToast('Could not load older sessions.');
      } finally {
        this.sessionsLoadingMore = false;
      }
    },

    async retryServer(): Promise<void> {
      await this.loadSessions();
    },

    /** Creates a session server-side and returns its id (or `null` on
     * failure, after surfacing a toast). The caller navigates to the new
     * `/s/:id` — the route watcher then drives `openSession`. The freshly
     * created chat is marked `loaded` so that re-entrant open is a no-op
     * (no redundant history fetch for a session we just minted). */
    async newSession(): Promise<string | null> {
      try {
        const res = await fetch('/api/sessions', { method: 'POST' });
        if (!res.ok) throw new Error(`POST /api/sessions failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        this.sessions.unshift({ id, title: null, updated_at: Date.now(), turns: 0, cost_usd: 0 });
        const chat = this.ensureChat(id);
        chat.loaded = true;
        this.activeId = id;
        this.sessionNotFound = false;
        return id;
      } catch {
        this.pushToast('Could not start a new session — is the server running?');
        this.serverUnreachable = true;
        return null;
      }
    },

    /** Loads a session's full history (once) then switches to it. Reuses
     * the exact same `applyEvent` fold the live channels use — "open" and
     * "watch live" are one code path. */
    async openSession(id: string): Promise<void> {
      this.activeId = id;
      this.sessionNotFound = false;
      const chat = this.ensureChat(id);
      if (chat.loaded) {
        if (chat.running && !chat.reconnecting) void this.reconnect(id);
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${id}/events`);
        // A definitive 404 means "no such session" (e.g. a direct-loaded or
        // stale `/s/:id`) — a distinct empty state, not a transport failure.
        if (res.status === 404) {
          this.sessionNotFound = true;
          return;
        }
        if (!res.ok) throw new Error(`GET events failed: ${res.status}`);
        const events = (await res.json()) as unknown[];
        for (const ev of events) applyEvent(chat, normalizeEvent(ev));
        chat.loaded = true;
        this.serverUnreachable = false;
        // A session whose last-known turn never reached `turn.completed`
        // (dropped mid-turn before this client ever opened it) still needs
        // to be watched for whatever's currently live.
        if (chat.running) void this.reconnect(id);
      } catch {
        this.serverUnreachable = true;
      }
    },

    /** Sends a user message on the primary live channel (`POST
     * .../messages`, fetch-streamed — never `EventSource`, which cannot
     * read a POST response). Folds every frame as it arrives; an
     * unexpected drop hands off to `reconnect` with the latest known seq
     * (never 0 — see Task 15's binding ruling). */
    async send(text: string): Promise<void> {
      const id = this.activeId;
      if (!id) return;
      const chat = this.ensureChat(id);
      if (chat.running) {
        this.pushToast('A turn is already running.');
        return;
      }
      chat.error = null;
      chat.sendError = null;
      chat.running = true;
      // Tracks whether the POST ever produced a single frame. This is the
      // bit that decides which failure path below applies — see the two
      // branches in `catch` for why it matters.
      let receivedAnyFrame = false;
      try {
        const frames = await fetchSse(`/api/sessions/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.selectedModel ? { text, model: this.selectedModel } : { text }),
        });
        for await (const frame of frames) {
          receivedAnyFrame = true;
          applyEvent(chat, frame.data as AppEvent);
        }
        chat.running = false; // stream closed normally at this turn's memory.snapshot
        chat.lastFailedText = null;
        void this.refreshSessionMeta();
      } catch (err) {
        if (err instanceof SseHttpError && err.status === 409) {
          chat.running = false;
          this.pushToast('A turn is already running.');
          return;
        }
        if (!receivedAnyFrame) {
          // The POST never produced a single frame: either it never
          // reached the server at all (offline/connection refused — a
          // plain `fetch` rejection) or the server rejected it outright
          // with a non-409 HTTP error (4xx/5xx). Either way, NO turn was
          // ever started server-side for this attempt, so there is
          // nothing for `GET .../stream` to resume — reconnecting here
          // would open a stream against a session with no new events and
          // just sit on heartbeats forever. Reset `running` and surface a
          // distinct "failed to send" control that retries the SEND
          // itself, not a stream reconnect.
          chat.running = false;
          chat.lastFailedText = text;
          chat.sendError = describeSendFailure(err);
          return;
        }
        // At least one frame arrived (we saw turn.started, at minimum) —
        // a real turn WAS started server-side and the connection then
        // dropped mid-stream. This IS resumable via the reconnect channel
        // using the latest known seq (never 0 — Task 15's binding ruling).
        chat.error = 'Connection dropped — reconnecting…';
        await this.reconnect(id);
      }
    },

    /** Resubmits the message that failed to ever reach the server
     * (`chat.sendError`/`chat.lastFailedText`) — a plain retry of `send`,
     * not a stream reconnect (see `send`'s catch branch for why those are
     * different failure modes). */
    async retrySend(): Promise<void> {
      const id = this.activeId;
      if (!id) return;
      const chat = this.chats[id];
      const text = chat?.lastFailedText;
      if (!text) return;
      chat.sendError = null;
      await this.send(text);
    },

    /** Reconnect channel (`GET .../stream?afterSeq`) — used both after an
     * unexpected MID-STREAM drop and when opening a session that was left
     * mid-turn. Always passes the latest known `seq`, retries with capped
     * exponential backoff, bounds EACH attempt with
     * `RECONNECT_ATTEMPT_TIMEOUT_MS` (so a stream that opens but never
     * yields anything can't hang the loop forever), and surfaces a banner
     * (via `chat.error`) with a manual-retry control if every attempt
     * fails — no path here can spin forever. */
    async reconnect(id: string): Promise<void> {
      const chat = this.ensureChat(id);
      if (chat.reconnecting) return;
      chat.reconnecting = true;

      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), RECONNECT_ATTEMPT_TIMEOUT_MS);
        try {
          const frames = await fetchSse(`/api/sessions/${id}/stream?afterSeq=${chat.lastSeq}`, {
            method: 'GET',
            signal: timeoutController.signal,
          });
          for await (const frame of frames) {
            applyEvent(chat, frame.data as AppEvent);
          }
          clearTimeout(timeoutId);
          // Stream closed cleanly (server closes on the first memory.snapshot
          // it sees). If the turn is now finished, we're done; if the server
          // closed on some OTHER turn's snapshot while this one is still
          // running (the documented `/stream` simplification — see Task 15's
          // cross-task note), reconnect again with the now-advanced seq.
          if (!chat.running) {
            chat.error = null;
            chat.reconnecting = false;
            return;
          }
        } catch {
          clearTimeout(timeoutId);
          // Covers both a real network failure AND the per-attempt timeout
          // above firing on a silently-hung stream — both fall through to
          // the same bounded backoff/retry below.
        }
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          chat.error = 'Connection dropped — reconnecting…';
          await sleep(Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), 8000));
        }
      }

      chat.error = 'Lost connection to the server. The turn may still be running — try reconnecting.';
      chat.reconnecting = false;
    },

    async confirm(confirmId: string, approved: boolean, editedParams?: Record<string, unknown>): Promise<void> {
      const id = this.activeId;
      if (!id) return;
      const chat = this.chats[id];
      const turn = chat?.turns.find((t) => t.pendingConfirm?.confirmId === confirmId);
      // Optimistically disable the buttons the instant the user acts — the
      // authoritative `confirmation.resolved` event (delivered on whichever
      // channel is open) confirms/corrects this shortly after.
      if (turn?.pendingConfirm) turn.pendingConfirm.resolved = true;
      try {
        const body = editedParams && Object.keys(editedParams).length > 0 ? { approved, editedParams } : { approved };
        const res = await fetch(`/api/sessions/${id}/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) this.pushToast(`Could not resolve confirmation (HTTP ${res.status}).`);
      } catch {
        this.pushToast('Network error resolving the confirmation.');
      }
    },

    async cancel(): Promise<void> {
      const id = this.activeId;
      if (!id) return;
      try {
        const res = await fetch(`/api/sessions/${id}/cancel`, { method: 'POST' });
        if (!res.ok) this.pushToast(`Could not cancel the turn (HTTP ${res.status}).`);
      } catch {
        this.pushToast('Network error cancelling the turn.');
      }
    },

    /** Task 19's `TraceView`: on-demand fetch of a completed turn's span
     * waterfall (`GET /api/traces/:turnId` → `{spans}`). Cached per
     * `turnId` — re-opening an already-loaded trace panel doesn't re-fetch.
     * Best-effort like the other read-only GETs in this store: a failure
     * sets `error` for the panel to render, never throws into the caller. */
    async loadTrace(turnId: string): Promise<void> {
      const existing = this.traces[turnId];
      if (existing && (existing.loading || existing.spans.length > 0)) return;
      this.traces[turnId] = { spans: existing?.spans ?? [], loading: true, error: null };
      try {
        const res = await fetch(`/api/traces/${turnId}`);
        if (!res.ok) throw new Error(`GET /api/traces failed: ${res.status}`);
        const body = (await res.json()) as { spans: Span[] };
        this.traces[turnId] = { spans: body.spans, loading: false, error: null };
      } catch {
        this.traces[turnId] = { spans: [], loading: false, error: 'Could not load the span trace.' };
      }
    },

    /** Re-pulls the sidebar's session rows (title/updated_at/turns/cost)
     * after a turn completes — best-effort, failures are silent since this
     * never blocks the chat itself. */
    async refreshSessionMeta(): Promise<void> {
      try {
        const res = await fetch(`/api/sessions?limit=${SESSIONS_PAGE_SIZE}`);
        if (res.ok) {
          const rows = (await res.json()) as SessionSummary[];
          this.sessions = rows;
          this.sessionsHasMore = rows.length === SESSIONS_PAGE_SIZE;
        }
      } catch {
        // Best-effort — the active chat state already reflects reality;
        // only the sidebar's summary row would be stale.
      }
    },
  },
});
