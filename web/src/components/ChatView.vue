<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session.js';
import TaskTracker from './TaskTracker.vue';
import ConfirmCard from './ConfirmCard.vue';
import ClarifyCard from './ClarifyCard.vue';
import CostBadge from './CostBadge.vue';
import TraceView from './TraceView.vue';
import AuditFeed from './AuditFeed.vue';
import type { TurnView } from '../lib/fold.js';
import { formatSessionLedger, sumSessionMetrics } from '../lib/ledger.js';
import { renderMarkdown } from '../lib/markdown.js';

const props = defineProps<{ sessionId: string }>();
defineEmits<{ 'toggle-nav': [] }>();
const store = useSessionStore();

const chat = computed(() => store.chats[props.sessionId] ?? null);
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
/** True once the user has scrolled up away from the bottom — pauses the
 * auto-scroll-to-latest behavior and surfaces a "scroll to latest" button
 * instead of yanking the view out from under someone reading back. */
const isScrolledUp = ref(false);
const SCROLL_BOTTOM_THRESHOLD_PX = 48;
/** Max composer height — 4 lines — computed once from the textarea's own
 * font metrics so it stays correct regardless of font-size/line-height. */
const TEXTAREA_MAX_LINES = 4;

const EXAMPLE_PROMPTS = [
  'Find leads created in the last week',
  'Show me unpaid invoices that are overdue',
  'What open slots are there on the calendar?',
];

const sessionTitle = computed(() => {
  const s = store.sessions.find((row) => row.id === props.sessionId);
  return s?.title && s.title.length > 0 ? s.title : 'New chat';
});

/** Cumulative session cost/token ledger — sums every completed turn's
 * `turn.completed` metrics. `''` (hidden) for a session with no completed
 * turns yet. */
const sessionLedger = computed(() => formatSessionLedger(sumSessionMetrics(chat.value?.turns ?? [])));

/** True between `turn.started` and `plan.ready` (or any other outcome that
 * sets `turn.kind`) — the window where the agent is deciding what to do but
 * has nothing to show yet. `turn.kind` is set for every PlanOutcome variant
 * (see `lib/fold.ts`'s `plan.ready` branch), so `!turn.kind` is an accurate
 * "still planning" signal for both live and historical turns. */
function isPlanning(turn: TurnView): boolean {
  return !turn.kind && !turn.status;
}

/** aria-live announcement of step progress for the most recent turn — "step
 * 3 of 5 done". Counts any terminal step (done/failed/skipped) against the
 * steps known so far (grows as the plan is revealed); empty until the first
 * step settles so nothing is announced for a turn with no steps yet. */
const stepAnnouncement = computed(() => {
  const turn = chat.value?.turns.at(-1);
  // Only announce for the turn that is genuinely in flight RIGHT NOW. Bulk-
  // replaying a historical session (or switching to a finished one) folds
  // every step to its terminal state, which would otherwise make this
  // recompute to "Step N of N done" and re-announce a long-finished turn to
  // assistive tech. `activeTurnId` is set on `turn.started` and cleared on
  // `turn.completed`, so it's non-null only while a live turn is running.
  if (!turn || turn.turnId !== chat.value?.activeTurnId) return '';
  if (turn.stepOrder.length === 0) return '';
  const total = turn.stepOrder.length;
  const settled = turn.stepOrder.filter((id) => {
    const s = turn.steps[id];
    return s !== undefined && s.status !== 'pending' && s.status !== 'running';
  }).length;
  if (settled === 0) return '';
  return `Step ${settled} of ${total} done`;
});

/** Inspector drawer: audit ledger (session-wide) or a selected turn's trace
 * waterfall. Local state — reset when the session changes. */
type Inspector = { tab: 'audit' | 'trace'; turnId: string | null };
const inspector = ref<Inspector | null>(null);

watch(
  () => props.sessionId,
  () => {
    inspector.value = null;
  },
);

function openAudit(): void {
  if (inspector.value?.tab === 'audit') {
    inspector.value = null;
    return;
  }
  inspector.value = { tab: 'audit', turnId: inspector.value?.turnId ?? null };
}
function openTrace(turnId: string): void {
  inspector.value = { tab: 'trace', turnId };
}
function closeInspector(): void {
  inspector.value = null;
}

const FAIL_STATUSES = new Set(['failed', 'refused', 'cancelled']);
function statusToken(status: string | undefined): string | null {
  if (!status || status === 'done' || status === 'clarify') return null;
  return status;
}
function isFailStatus(status: string | undefined): boolean {
  return status !== undefined && FAIL_STATUSES.has(status);
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  isScrolledUp.value = false;
}

/** Tracks whether the user has manually scrolled away from the bottom —
 * read by the two watchers below (so an in-flight turn's new frames don't
 * yank the view back down while someone's reading up-thread) and by the
 * "scroll to latest" button's visibility. */
function onTranscriptScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  isScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_BOTTOM_THRESHOLD_PX;
}

async function scrollToLatest(): Promise<void> {
  await scrollToBottom();
}

watch(
  () => chat.value?.turns.length,
  () => {
    if (!isScrolledUp.value) void scrollToBottom();
  },
);
watch(
  () => chat.value?.turns.at(-1)?.deltaText,
  () => {
    if (!isScrolledUp.value) void scrollToBottom();
  },
);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || chat.value?.running) return;
  draft.value = '';
  await store.send(text);
}

function useExample(text: string): void {
  draft.value = text;
}

/** A clarify chip's pick: fill the composer with the exact option text and
 * send it immediately, same as a manual type+Enter. */
function onClarifyReply(text: string): void {
  draft.value = text;
  void onSend();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void onSend();
  }
}

/** Grows the composer up to `TEXTAREA_MAX_LINES` as the draft grows, then
 * leaves it to scroll internally — never taller than that cap. Recomputed
 * from the textarea's own font metrics (not a hardcoded px value) so it
 * stays correct regardless of font-size/line-height. */
function autosizeTextarea(): void {
  const el = textareaEl.value;
  if (!el) return;
  const style = getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const verticalBorderPadding =
    parseFloat(style.borderTopWidth) +
    parseFloat(style.borderBottomWidth) +
    parseFloat(style.paddingTop) +
    parseFloat(style.paddingBottom);
  const maxPx = lineHeight * TEXTAREA_MAX_LINES + verticalBorderPadding;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
}

watch(draft, () => void nextTick(autosizeTextarea));

function onInspectorKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && inspector.value) {
    e.preventDefault();
    closeInspector();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onInspectorKeydown);
  autosizeTextarea();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onInspectorKeydown);
});

async function onCancel(): Promise<void> {
  await store.cancel();
}

async function onResolveConfirm(confirmId: string, approved: boolean): Promise<void> {
  await store.confirm(confirmId, approved);
}

async function onRetryConnection(): Promise<void> {
  await store.reconnect(props.sessionId);
}

async function onRetrySend(): Promise<void> {
  await store.retrySend();
}

/** Copies a direct link to this session (`/s/:id`) to the clipboard so it
 * can be shared or reopened. Best-effort — a clipboard rejection still
 * surfaces a toast rather than throwing. */
async function onCopyLink(): Promise<void> {
  const url = `${window.location.origin}/s/${props.sessionId}`;
  try {
    await navigator.clipboard.writeText(url);
    store.pushToast('Link copied');
  } catch {
    store.pushToast('Could not copy the link.');
  }
}
</script>

<template>
  <div class="chat-view" v-if="chat">
    <header class="transcript-head">
      <button
        class="nav-toggle"
        aria-label="Toggle sessions"
        @click="$emit('toggle-nav')"
      >
        ☰
      </button>
      <div class="transcript-title">{{ sessionTitle }}</div>
      <span v-if="sessionLedger" class="cost-badge session-ledger">{{ sessionLedger }}</span>
      <button class="ghost-btn" title="Copy a link to this session" @click="onCopyLink">
        Copy link
      </button>
      <button
        class="ghost-btn"
        :class="{ 'is-on': inspector?.tab === 'audit' }"
        @click="openAudit"
      >
        Audit
      </button>
    </header>

    <!-- Announces step progress for the active turn to assistive tech —
         visually hidden, polite (never interrupts). -->
    <div class="sr-only" aria-live="polite">{{ stepAnnouncement }}</div>

    <!-- The message never reached the server (no turn was ever started) —
         retrying means re-sending, not reconnecting to a stream. -->
    <div v-if="chat.sendError" class="banner banner-error">
      <span>{{ chat.sendError }}</span>
      <button class="btn" @click="onRetrySend">Retry send</button>
    </div>
    <!-- A turn DID start server-side and then the connection dropped —
         auto-reconnect already ran; this banner means every attempt failed. -->
    <div v-if="chat.error" class="banner banner-error">
      <span>{{ chat.error }}</span>
      <button class="btn" @click="onRetryConnection">Retry now</button>
    </div>

    <div class="transcript" ref="scrollEl" @scroll="onTranscriptScroll">
      <div class="transcript-inner">
        <div v-if="chat.turns.length === 0" class="start">
          <div class="start-name">Ask AI</div>
          <p class="start-line">
            A legible agent for your CRM — ask in plain language and watch every step it takes.
          </p>
          <div class="start-chips">
            <button
              v-for="p in EXAMPLE_PROMPTS"
              :key="p"
              class="chip"
              @click="useExample(p)"
            >
              {{ p }}
            </button>
          </div>
        </div>

        <article v-for="turn in chat.turns" :key="turn.turnId" class="turn">
          <div class="speaker">
            <span class="speaker-name">You</span>
            <span class="speaker-rule"></span>
          </div>
          <div class="said said-user">{{ turn.userText }}</div>

          <div class="speaker" style="margin-top: 16px">
            <span class="speaker-name">Ask AI</span>
            <span class="speaker-rule"></span>
            <span v-if="isPlanning(turn)" class="planning-indicator">
              Planning<span class="planning-dot">.</span><span class="planning-dot">.</span><span
                class="planning-dot"
                >.</span
              >
            </span>
            <span
              v-if="statusToken(turn.status)"
              :class="['turn-status', { 'is-fail': isFailStatus(turn.status) }]"
              >{{ statusToken(turn.status) }}</span
            >
          </div>

          <div class="agent-body">
            <!-- Live tool-activity: the plan-dsl agent sets kind==='plan';
                 the tool-loop agent emits step events directly (no plan.ready),
                 so show the tracker whenever the turn has steps — that renders
                 "searching leads… checking contacts…" rows live via SSE. -->
            <TaskTracker v-if="turn.kind === 'plan' || turn.stepOrder.length > 0" :turn="turn" />

            <ClarifyCard v-if="turn.clarifyQuestion" :question="turn.clarifyQuestion" @reply="onClarifyReply" />

            <ConfirmCard
              v-if="turn.pendingConfirm"
              :confirm="turn.pendingConfirm"
              @resolve="onResolveConfirm"
            />

            <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown
                 escapes ALL input before emitting its fixed tag set, so no
                 model output can inject markup. -->
            <div
              v-if="turn.finalText || turn.deltaText || turn.unsupportedReason"
              :class="['said', 'said-agent', 'agent-section', { 'is-fail': isFailStatus(turn.status) }]"
              v-html="renderMarkdown(turn.finalText || turn.deltaText || turn.unsupportedReason || '')"
            ></div>
          </div>

          <div v-if="turn.status" class="turn-foot">
            <CostBadge v-if="turn.metrics" :metrics="turn.metrics" />
            <div class="foot-actions">
              <button class="foot-btn" @click="openTrace(turn.turnId)">Trace</button>
            </div>
          </div>
        </article>
      </div>

      <button
        v-if="chat.running && isScrolledUp"
        type="button"
        class="scroll-latest-btn"
        @click="scrollToLatest"
      >
        ↓ New activity
      </button>
    </div>

    <div class="composer">
      <div class="composer-inner">
        <textarea
          ref="textareaEl"
          v-model="draft"
          :disabled="chat.running"
          placeholder="Message Ask AI…"
          @keydown="onKeydown"
          @input="autosizeTextarea"
        ></textarea>
        <button v-if="chat.running" class="btn-cancel" @click="onCancel">Cancel</button>
        <button v-else class="btn-send" :disabled="!draft.trim()" @click="onSend">Send</button>
      </div>
    </div>

    <!-- inspector drawer: slides over the transcript -->
    <template v-if="inspector">
      <div class="inspector-scrim" @click="closeInspector"></div>
      <aside class="inspector" role="dialog" aria-label="Inspector">
        <div class="inspector-head">
          <span class="inspector-title">Inspector</span>
          <button class="inspector-close" aria-label="Close inspector" @click="closeInspector">
            ×
          </button>
        </div>
        <div class="inspector-tabs">
          <button
            class="inspector-tab"
            :class="{ 'is-on': inspector.tab === 'audit' }"
            @click="inspector = { tab: 'audit', turnId: inspector?.turnId ?? null }"
          >
            Audit ledger
          </button>
          <button
            class="inspector-tab"
            :class="{ 'is-on': inspector.tab === 'trace' }"
            :disabled="!inspector.turnId"
            @click="inspector.turnId && (inspector = { tab: 'trace', turnId: inspector.turnId })"
          >
            Trace
          </button>
        </div>
        <div class="inspector-body">
          <AuditFeed v-if="inspector.tab === 'audit'" :turns="chat.turns" />
          <TraceView
            v-else-if="inspector.tab === 'trace' && inspector.turnId"
            :key="inspector.turnId"
            :turn-id="inspector.turnId"
          />
          <div v-else class="inspector-hint">Open a turn's trace from its footer.</div>
        </div>
      </aside>
    </template>
  </div>
</template>
