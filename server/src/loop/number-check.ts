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
// Day-before-month spoken order ("13 November 2026", "13 Nov 2026") — the EU
// way a scheduling confirmation reads a date. Without this the leading day
// number is scanned as a bare unverified figure ("could not verify: 13").
const DAY_MONTH_RE =
  /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:,?\s+(\d{4}))?\b/gi;
// no trailing \b — ISO timestamps continue with 'T' (digit→T is no boundary)
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})/g;
// Slash-separated numeric date (13/11/2026 EU, 11/13/2026 US). Requires TWO
// slashes and a 2-4 digit year so a bare ratio ("3/5") is never a date. The
// day/month order is ambiguous, so both interpretations are tried; the date's
// day number must never be scanned as a standalone unverified figure.
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
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

// Magnitude suffixes a model uses to present a grounded figure in human form
// ("$19.1M", "2.3 billion", "1.1k"). Captured as part of the figure so the
// token is never mangled to "$19.1", and expanded so the value can match the
// underlying grounded number.
const SUFFIX_MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};
// A draft figure: optional $, digits/commas, optional decimals, optional
// magnitude suffix (word-bounded so "5 meeting rooms" is not "5 million").
const DRAFT_FIGURE_RE =
  /\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:thousand|million|billion|mn|bn|k|m|b)\b)?/gi;
const FIGURE_PARTS_RE =
  /^(\$?)([\d,]+(?:\.\d+)?)(?:\s?(thousand|million|billion|mn|bn|k|m|b))?$/i;

/** Parse a draft figure into its numeric value and its DISPLAYED precision —
 * the place value of its least-significant shown digit (decimals, trailing
 * zeros, and any magnitude suffix taken into account). Precision > 1 means the
 * figure is rounded, so it may verify against a nearby grounded value. */
function parseFigure(raw: string): { value: number; precision: number } | null {
  const mm = FIGURE_PARTS_RE.exec(raw.trim());
  if (!mm) return null;
  const digits = (mm[2] as string).replace(/,/g, '');
  const base = Number(digits);
  if (!Number.isFinite(base)) return null;
  const suf = mm[3] ? (mm[3] as string).toLowerCase() : '';
  const mult = suf ? (SUFFIX_MULT[suf] ?? 1) : 1;
  const dot = digits.indexOf('.');
  let precision: number;
  if (dot >= 0) {
    const frac = digits.length - dot - 1;
    precision = Math.pow(10, -frac) * mult;
  } else {
    const z = digits.length - digits.replace(/0+$/, '').length; // trailing zeros
    precision = Math.pow(10, z) * mult;
  }
  return { value: base * mult, precision };
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
  // Memory grants EXACT membership only (restating a remembered figure/date is
  // not a fabrication); it is deliberately kept OUT of the arithmetic pool —
  // pairwise sums/differences and day-diffs derive from TOOL outputs only, so
  // a fabricated figure that merely equals the sum of two unrelated memories
  // cannot "support" itself through memory.
  extraEvidence: readonly string[] = [],
): NumberCheckResult {
  const outputs = toolOutputs.join('\n');
  const memory = extraEvidence.join('\n');
  // ids/names the USER typed, and anything in recalled memory, are evidence too
  const evidence = `${outputs}\n${userText}\n${memory}`;
  const evidenceLower = evidence.toLowerCase();

  // derivation pool: every number in TOOL outputs plus cents/dollars variants
  const pool: number[] = [];
  const numericOutputs = outputs.replace(ISO_TIMESTAMP_RE, ' ');
  for (const m of numericOutputs.matchAll(NUMBER_RE)) {
    const n = parseNum(m[0]);
    if (!Number.isFinite(n)) continue;
    pool.push(n, n / 100, n * 100);
    if (pool.length >= MAX_POOL * 3) break;
  }
  // memory numbers: exact membership + the same figure's cents/dollars variant,
  // never cross-number derivation.
  const memExact: number[] = [];
  const numericMemory = memory.replace(ISO_TIMESTAMP_RE, ' ');
  for (const m of numericMemory.matchAll(NUMBER_RE)) {
    const n = parseNum(m[0]);
    if (!Number.isFinite(n)) continue;
    memExact.push(n, n / 100, n * 100);
    if (memExact.length >= MAX_POOL * 3) break;
  }
  // Figures the USER stated in THIS request are supported — echoing the user's
  // own number back ("your target is $50k") is never fabrication. Parsed with
  // the magnitude-aware scanner so "$50k" matches "$50,000"; exact membership
  // only (no cross-number derivation), like memory.
  const userExact: number[] = [];
  for (const m of userText.matchAll(DRAFT_FIGURE_RE)) {
    const pf = parseFigure(m[0].trim());
    if (pf && Number.isFinite(pf.value)) userExact.push(pf.value, pf.value / 100, pf.value * 100);
    if (userExact.length >= MAX_POOL * 3) break;
  }
  // Raw output numbers (the `n` of each [n, n/100, n*100] triple) — the basis
  // for pairwise derivation and rounded-figure matching.
  const rawNums = pool.filter((_, i) => i % 3 === 0);
  const supported = (claim: number, precision = 1): boolean => {
    if (pool.some((c) => close(claim, c))) return true;
    if (memExact.some((c) => close(claim, c))) return true; // memory: exact only
    if (userExact.some((c) => close(claim, c))) return true; // user's own stated figure
    // Rounded figure (precision > 1, e.g. "$19.1M", "~1,100"): accept if a
    // grounded value rounds to it at its displayed precision. Checked against
    // the raw output number and its dollars (÷100) variant only — never the
    // ×100 variant, so a small unrelated number cannot scale up into range.
    if (precision > 1) {
      const tol = precision / 2 + EPS;
      if (rawNums.some((c) => Math.abs(c - claim) <= tol || Math.abs(c / 100 - claim) <= tol)) return true;
    }
    // pairwise sum/difference of raw output figures (first variant only)
    const raws = rawNums.slice(0, 120);
    for (let i = 0; i < raws.length; i += 1) {
      for (let j = i; j < raws.length; j += 1) {
        const a = raws[i] as number;
        const b = raws[j] as number;
        if (close(claim, a + b) || close(claim, Math.abs(a - b)) || close(claim, (a + b) / 100) || close(claim, Math.abs(a - b) / 100)) return true;
      }
    }
    return false;
  };

  // ISO dates available in outputs, as month-day(-year) tuples. Only TOOL-output
  // dates feed day-diff derivation; memory dates are exact-membership only.
  const outputDates = new Set<string>();
  const dateMs: number[] = [];
  for (const m of outputs.matchAll(ISO_DATE_RE)) {
    outputDates.add(`${Number(m[2])}-${Number(m[3])}-${m[1]}`);
    outputDates.add(`${Number(m[2])}-${Number(m[3])}`);
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isFinite(ms) && dateMs.length < 60) dateMs.push(ms);
  }
  for (const m of memory.matchAll(ISO_DATE_RE)) {
    outputDates.add(`${Number(m[2])}-${Number(m[3])}-${m[1]}`);
    outputDates.add(`${Number(m[2])}-${Number(m[3])}`);
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
    .replace(NUMERIC_DATE_RE, ' ')
    .replace(DAY_MONTH_RE, ' ')
    .replace(MONTH_DAY_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(ISO_DATE_RE, (iso) => {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (m && !outputDates.has(`${Number(m[2])}-${Number(m[3])}-${m[1]}`)) unsupported.push(iso);
    return ' ';
  });

  for (const m of numericDraft.matchAll(DRAFT_FIGURE_RE)) {
    const raw = m[0].trim();
    const parsed = parseFigure(raw);
    if (parsed === null) continue;
    const { value: n, precision } = parsed;
    if (!Number.isFinite(n)) continue;
    if (!raw.startsWith('$') && Math.abs(n) <= SMALL_INT_MAX && Number.isInteger(n)) continue;
    if (isYear(n, raw)) continue;
    if (!supported(n, precision)) unsupported.push(raw);
  }

  // Day-before-month spoken dates ("13 November 2026") — verified first, then
  // removed so the month-day scan below cannot mis-read "November 2026" as a
  // bogus "November 20".
  for (const m of draft.matchAll(DAY_MONTH_RE)) {
    const day = Number(m[1]);
    const month = MONTHS[(m[2] as string).slice(0, 3).toLowerCase()] as number;
    const year = m[3];
    const key = year ? `${month}-${day}-${year}` : `${month}-${day}`;
    if (!outputDates.has(key) && !outputDates.has(`${month}-${day}`)) unsupported.push(m[0]);
  }
  const draftSansDayMonth = draft.replace(DAY_MONTH_RE, ' ');
  for (const m of draftSansDayMonth.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()] as number;
    const day = Number(m[2]);
    const year = m[3];
    const key = year ? `${month}-${day}-${year}` : `${month}-${day}`;
    const keyNoYear = `${month}-${day}`;
    if (!outputDates.has(key) && !outputDates.has(keyNoYear)) unsupported.push(m[0]);
  }

  // Numeric slash dates: supported if EITHER day/month ordering matches an
  // output date (the format is locale-ambiguous). Only orderings with a valid
  // 1-12 month and 1-31 day are considered.
  for (const m of draft.matchAll(NUMERIC_DATE_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let yr = Number(m[3]);
    if (yr < 100) yr += 2000;
    const keys: string[] = [];
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31) keys.push(`${b}-${a}-${yr}`, `${b}-${a}`); // DD/MM
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) keys.push(`${a}-${b}-${yr}`, `${a}-${b}`); // MM/DD
    if (keys.length === 0 || !keys.some((k) => outputDates.has(k))) unsupported.push(m[0]);
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
    // Report the plain id, NOT a `[[record:…:id]]` pseudo-token: name-resolve
    // runs over the whole answer (including this caution) and would wrap the
    // bare id inside the pseudo-token, producing a mangled nested chip.
    if (!evidence.includes(id)) unsupported.push(id);
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
