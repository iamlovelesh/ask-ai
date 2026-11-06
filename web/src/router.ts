/**
 * Session URL routing (Feature A). Two addressable states:
 *   - `/`            → the new-chat state (no session yet; first message
 *                      creates a session and navigates to its `/s/:id`)
 *   - `/s/:sessionId`→ an opened session's transcript
 *
 * The router is deliberately thin: it owns the URL, the Pinia session store
 * stays the single source of truth for chat state. `App.vue` watches the
 * matched `sessionId` param and drives `store.openSession(id)` / clears the
 * active session for `/`, so "navigate" and "open" are one path and browser
 * back/forward Just Work. Route records carry no visual component (the app
 * renders its own layout from `App.vue`), only a stable `name`/`path` the
 * app reads — a tiny sink component satisfies vue-router's per-record
 * component requirement without a `<router-view>`.
 */

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { defineComponent } from 'vue';

/** Renders nothing — the layout lives in `App.vue`; routes exist only to
 * make the current session addressable. */
const RouteSink = defineComponent({ name: 'RouteSink', render: () => null });

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: RouteSink },
  { path: '/s/:sessionId', name: 'session', component: RouteSink },
  { path: '/memories', name: 'memories', component: RouteSink },
  // Anything else (a stale/garbled link) falls back to the new-chat state.
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
];

export function createAppRouter() {
  return createRouter({
    history: createWebHistory(),
    routes,
  });
}
