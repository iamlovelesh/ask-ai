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
const MAX_POOL = 400;
const EPS = 0.006;

function parseNum(raw: string): number {
  return Number(raw.replace(/[$,]/g, ''));
}

function isYear(n: number, raw: string): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2099 && !raw.includes('.') && !raw.startsWith('$');
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(EPS, Math.abs(b) * 1e-6);
}

export function numberCheck(draft: string, toolOutputs: readonly string[]): NumberCheckResult {
  const outputs = toolOutputs.join('\n');

  // candidate pool: every number in outputs plus cents/dollars variants
  const pool: number[] = [];
  for (const m of outputs.matchAll(NUMBER_RE)) {
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
  for (const m of outputs.matchAll(ISO_DATE_RE)) {
    outputDates.add(`${Number(m[2])}-${Number(m[3])}-${m[1]}`);
    outputDates.add(`${Number(m[2])}-${Number(m[3])}`);
  }

  const unsupported: string[] = [];

  // strip times and month-day phrases from the numeric scan (handled separately)
  const numericDraft = draft.replace(MONTH_DAY_RE, ' ').replace(TIME_RE, ' ').replace(ISO_DATE_RE, (iso) => {
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

  return { ok: unsupported.length === 0, unsupported };
}
