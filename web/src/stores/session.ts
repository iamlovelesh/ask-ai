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
import type { AppEvent } from '../lib/events.js';

export interface SessionSummary {
  id: string;
  title: string | null;
  updated_at: number;
  turns: number;
  cost_usd: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const TOAST_LIFETIME_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as SessionSummary[],
    activeId: null as string | null,
    chats: {} as Record<string, SessionChatState>,
    /** Set when the app can't even load the session list — drives the
     * app-level "server unreachable" retry screen (distinct from a
     * per-session SSE-drop banner, which uses `chat.error`). */
    serverUnreachable: false,
    toasts: [] as { id: number; text: string }[],
    toastSeq: 0,
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

    async loadSessions(): Promise<void> {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
        this.sessions = (await res.json()) as SessionSummary[];
        this.serverUnreachable = false;
      } catch {
        this.serverUnreachable = true;
      }
    },

    async retryServer(): Promise<void> {
      await this.loadSessions();
    },

    async newSession(): Promise<void> {
      try {
        const res = await fetch('/api/sessions', { method: 'POST' });
        if (!res.ok) throw new Error(`POST /api/sessions failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        this.sessions.unshift({ id, title: null, updated_at: Date.now(), turns: 0, cost_usd: 0 });
        const chat = this.ensureChat(id);
        chat.loaded = true;
        this.activeId = id;
      } catch {
        this.pushToast('Could not start a new session — is the server running?');
        this.serverUnreachable = true;
      }
    },

    /** Loads a session's full history (once) then switches to it. Reuses
     * the exact same `applyEvent` fold the live channels use — "open" and
     * "watch live" are one code path. */
    async openSession(id: string): Promise<void> {
      this.activeId = id;
      const chat = this.ensureChat(id);
      if (chat.loaded) {
        if (chat.running && !chat.reconnecting) void this.reconnect(id);
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${id}/events`);
        if (!res.ok) throw new Error(`GET events failed: ${res.status}`);
        const events = (await res.json()) as AppEvent[];
        for (const ev of events) applyEvent(chat, ev);
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
      chat.running = true;
      try {
        const frames = await fetchSse(`/api/sessions/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        for await (const frame of frames) {
          applyEvent(chat, frame.data as AppEvent);
        }
        chat.running = false; // stream closed normally at this turn's memory.snapshot
        void this.refreshSessionMeta();
      } catch (err) {
        if (err instanceof SseHttpError && err.status === 409) {
          chat.running = false;
          this.pushToast('A turn is already running.');
          return;
        }
        chat.error = 'Connection dropped — reconnecting…';
        await this.reconnect(id);
      }
    },

    /** Reconnect channel (`GET .../stream?afterSeq`) — used both after an
     * unexpected drop and when opening a session that was left mid-turn.
     * Always passes the latest known `seq`, retries with backoff, and
     * surfaces a banner (via `chat.error`) if every attempt fails. */
    async reconnect(id: string): Promise<void> {
      const chat = this.ensureChat(id);
      if (chat.reconnecting) return;
      chat.reconnecting = true;

      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        try {
          const frames = await fetchSse(`/api/sessions/${id}/stream?afterSeq=${chat.lastSeq}`, {
            method: 'GET',
          });
          for await (const frame of frames) {
            applyEvent(chat, frame.data as AppEvent);
          }
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
          // fall through to backoff/retry below
        }
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          chat.error = 'Connection dropped — reconnecting…';
          await sleep(Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), 8000));
        }
      }

      chat.error = 'Lost connection to the server. The turn may still be running — try reconnecting.';
      chat.reconnecting = false;
    },

    async confirm(confirmId: string, approved: boolean): Promise<void> {
      const id = this.activeId;
      if (!id) return;
      const chat = this.chats[id];
      const turn = chat?.turns.find((t) => t.pendingConfirm?.confirmId === confirmId);
      // Optimistically disable the buttons the instant the user acts — the
      // authoritative `confirmation.resolved` event (delivered on whichever
      // channel is open) confirms/corrects this shortly after.
      if (turn?.pendingConfirm) turn.pendingConfirm.resolved = true;
      try {
        const res = await fetch(`/api/sessions/${id}/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved }),
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

    /** Re-pulls the sidebar's session rows (title/updated_at/turns/cost)
     * after a turn completes — best-effort, failures are silent since this
     * never blocks the chat itself. */
    async refreshSessionMeta(): Promise<void> {
      try {
        const res = await fetch('/api/sessions');
        if (res.ok) this.sessions = (await res.json()) as SessionSummary[];
      } catch {
        // Best-effort — the active chat state already reflects reality;
        // only the sidebar's summary row would be stale.
      }
    },
  },
});
