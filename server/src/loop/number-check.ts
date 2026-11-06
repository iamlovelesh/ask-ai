/**
 * NumberCheck (Chatwoot Captain pattern, adopted per the 2026-11-06 OSS
 * survey): a deterministic, model-free verifier that every figure and
 * month-day date in a draft answer is present in — or arithmetically
 * derivable from — this turn's tool outputs. Catches the fabrication
 * family (sample superlatives, invented totals, cross-record date
 * contamination) on turns WITH steps, where the zero-step grounding check
 * can't fire.
 *
 * Deliberately conservative about what counts as a claim: small integers
 * (list positions, example counts), bare years, and clock times are
 * ignored; conversions allowed are cents↔dollars (×/÷100) and pairwise
 * sum/difference of output figures.
 */

export interface NumberCheckResult {
  ok: boolean;
  unsupported: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?/g;
const MONTH_DAY_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi;
// no trailing \b — ISO timestamps continue with 'T' (digit→T is no boundary)
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})/g;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;

const SMALL_INT_MAX = 12;
const MAX_POOL = 2000;
const EPS = 0.006;

// ISO timestamps shed ~7 digit tokens each ("2026","05","15","19","33",...)
// — stripped from the numeric pool scan (round-7c: date-digit noise
// exhausted the pool before a correct tool-computed sum at the end of the
// last observation). Dates stay fully available to the date pool, which
// scans the UNstripped outputs.
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

function parseNum(raw: string): number {
  return Number(raw.replace(/[$,]/g, ''));
}

function isYear(n: number, raw: string): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2099 && !raw.includes('.') && !raw.startsWith('$');
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(EPS, Math.abs(b) * 1e-6);
}

const RECORD_TOKEN_RE = /\[\[record:([a-z_]+):([a-z_]+_\d+):((?:(?!\]\])[^\n])+)\]\]/g;
const BARE_ID_RE = /\b[a-z][a-z]*(?:_[a-z]+)*_\d+\b/g;

export function numberCheck(
  draft: string,
  toolOutputs: readonly string[],
  userText = '',
  // Additional supported-source corpus — recalled memory (design §4.6.1).
  // Folded into `outputs` so memory feeds the numeric pool, the date pool,
  // and the id/name evidence uniformly: a figure/date legitimately recalled
  // from memory is not a fabrication.
  extraEvidence: readonly string[] = [],
): NumberCheckResult {
  const outputs = [...toolOutputs, ...extraEvidence].join('\n');
  // ids/names the USER typed are legitimate evidence too
  const evidence = `${outputs}\n${userText}`;
  const evidenceLower = evidence.toLowerCase();

  // candidate pool: every number in outputs plus cents/dollars variants
  const pool: number[] = [];
  const numericOutputs = outputs.replace(ISO_TIMESTAMP_RE, ' ');
  for (const m of numericOutputs.matchAll(NUMBER_RE)) {
    const n = parseNum(m[0]);
    if (!Number.isFinite(n)) continue;
    pool.push(n, n / 100, n * 100);
    if (pool.length >= MAX_POOL * 3) break;
  }
  const supported = (claim: number): boolean => {
    if (pool.some((c) => close(claim, c))) return true;
    // pairwise sum/difference of raw output figures (first variant only)
    const raws = pool.filter((_, i) => i % 3 === 0).slice(0, 120);
    for (let i = 0; i < raws.length; i += 1) {
      for (let j = i; j < raws.length; j += 1) {
        const a = raws[i] as number;
        const b = raws[j] as number;
        if (close(claim, a + b) || close(claim, Math.abs(a - b)) || close(claim, (a + b) / 100) || close(claim, Math.abs(a - b) / 100)) return true;
      }
    }
    return false;
  };

  // ISO dates available in outputs, as month-day(-year) tuples
  const outputDates = new Set<string>();
  const dateMs: number[] = [];
  for (const m of outputs.matchAll(ISO_DATE_RE)) {
    outputDates.add(`${Number(m[2])}-${Number(m[3])}-${m[1]}`);
    outputDates.add(`${Number(m[2])}-${Number(m[3])}`);
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isFinite(ms) && dateMs.length < 60) dateMs.push(ms);
  }
  // day-count claims ("89 days overdue") derivable as |date_i - date_j|
  const DAY = 86_400_000;
  const dayDiffs = new Set<number>();
  for (let i = 0; i < dateMs.length; i += 1) {
    for (let j = i + 1; j < dateMs.length; j += 1) {
      const d = Math.abs((dateMs[i] as number) - (dateMs[j] as number)) / DAY;
      dayDiffs.add(Math.floor(d));
      dayDiffs.add(Math.ceil(d));
    }
  }
  for (const d of dayDiffs) pool.push(d);

  const unsupported: string[] = [];

  // strip times, month-day phrases, reference tokens, and record ids from
  // the numeric scan (each handled separately — id digit suffixes like
  // ticket_555 must not be treated as numeric claims)
  const numericDraft = draft
    .replace(RECORD_TOKEN_RE, ' ')
    .replace(BARE_ID_RE, ' ')
    .replace(MONTH_DAY_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(ISO_DATE_RE, (iso) => {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (m && !outputDates.has(`${Number(m[2])}-${Number(m[3])}-${m[1]}`)) unsupported.push(iso);
    return ' ';
  });

  for (const m of numericDraft.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const n = parseNum(raw);
    if (!Number.isFinite(n)) continue;
    if (!raw.startsWith('$') && Math.abs(n) <= SMALL_INT_MAX && Number.isInteger(n)) continue;
    if (isYear(n, raw)) continue;
    if (!supported(n)) unsupported.push(raw);
  }

  for (const m of draft.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()] as number;
    const day = Number(m[2]);
    const year = m[3];
    const key = year ? `${month}-${day}-${year}` : `${month}-${day}`;
    const keyNoYear = `${month}-${day}`;
    if (!outputDates.has(key) && !outputDates.has(keyNoYear)) unsupported.push(m[0]);
  }

  // Entity verification (round-7 support): reference tokens must cite an id
  // AND display name that actually appear in the evidence; bare record ids
  // in prose must come from the evidence too. Fabricated names/ids are the
  // numeral-free siblings of fabricated figures.
  const tokenIds = new Set<string>();
  for (const m of draft.matchAll(RECORD_TOKEN_RE)) {
    const id = m[2] as string;
    const name = (m[3] as string).trim();
    tokenIds.add(id);
    if (!evidence.includes(id)) unsupported.push(`[[record:…:${id}]]`);
    else if (name.length > 1 && !evidenceLower.includes(name.toLowerCase())) unsupported.push(name);
  }
  const draftSansTokens = draft.replace(RECORD_TOKEN_RE, ' ');
  for (const m of draftSansTokens.matchAll(BARE_ID_RE)) {
    const id = m[0];
    if (!tokenIds.has(id) && !evidence.includes(id)) unsupported.push(id);
  }

  // One report per distinct claim (round-7b N2): a figure repeated through a
  // draft must not multiply into a cry-wolf wall of flags.
  const unique = [...new Set(unsupported)];
  return { ok: unique.length === 0, unsupported: unique };
}
