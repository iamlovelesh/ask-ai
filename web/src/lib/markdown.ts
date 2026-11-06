/**
 * Minimal, XSS-safe markdown renderer for agent answers.
 *
 * The loop model writes light markdown (bold, inline code, numbered/bullet
 * lists, occasional ### headings); the chat view used to interpolate it as
 * plain text, showing literal `**` to users. This renders exactly that
 * subset and nothing more — input is HTML-escaped FIRST, and the only tags
 * this module can emit are <p> <br> <strong> <em> <code> <ol> <ul> <li>,
 * GFM pipe tables, and an inline bar chart (<div>/<span> with a computed,
 * clamped width) derived from a numeric 2-column table,
 * so no model output can smuggle markup through. No dependency: a full
 * markdown library is a bigger surface than the answers need.
 */

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `[[record:entity:id:Display Name]]` → chip (reference-token
 * pattern: the agent cites records with verbatim tokens; the UI renders
 * them as identifiable chips, so invented references become visible).
 * Operates on ALREADY-ESCAPED text; entity/id are restricted to a safe
 * charset, the display name is already HTML-escaped. */
function renderRecordChips(escaped: string): string {
  return escaped
    // Well-formed tokens → clickable chip.
    .replace(
      /\[\[record:([a-z_]+):([a-z_]+_\d+):((?:(?!\]\])[^\n])+)\]\]/g,
      (_m, entity: string, id: string, name: string) =>
        `<span class="record-chip" data-record="${entity}/${id}" title="${id}">${name}</span>`,
    )
    // Graceful degradation (ChatReferenceChip): any record token
    // that did NOT match the strict form (malformed entity/id) renders as
    // its plain display name — the last colon-segment — never a broken span
    // or a raw [[record:…]] leak to the user.
    .replace(
      /\[\[record:((?:(?!\]\])[^\n])+)\]\]/g,
      (_m, inner: string) => {
        const parts = inner.split(':');
        return (parts[parts.length - 1] ?? '').trim();
      },
    );
}

/** Inline transforms on already-escaped text: chips, `code`, **bold**, *em*. */
function renderInline(escaped: string): string {
  return renderRecordChips(escaped)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}

const ORDERED_RE = /^\s*\d+[.)]\s+/;
const BULLET_RE = /^\s*[-*•]\s+/;
const HEADING_RE = /^\s*#{1,6}\s+/;
// A GFM table delimiter row: cells of dashes with optional alignment colons.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** Split a pipe-table row into trimmed cells, dropping the empty edges that
 * optional leading/trailing pipes produce. */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.trim());
}

/** Plain text of a table cell (for chart labels/values): record tokens →
 * their display name, markdown emphasis/code markers stripped. Operates on
 * the already-HTML-escaped cell, so the result is safe as text content. */
function cellPlainText(escaped: string): string {
  return escaped
    .replace(/\[\[record:((?:(?!\]\])[^\n])+)\]\]/g, (_m, inner: string) => {
      const parts = inner.split(':');
      return (parts[parts.length - 1] ?? '').trim();
    })
    .replace(/[*`]/g, '')
    .trim();
}

/** Parse a numeric measure from a cell ("1,362", "$10,511.42", "52%") or null. */
function parseChartValue(cell: string): number | null {
  const cleaned = cell.replace(/[^0-9.\-]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const CHART_MAX_ROWS = 12;

/** A 2-column table whose second column is non-negative numbers across every
 * body row (a breakdown/ranking: "leads by status", "deals per owner") →
 * an inline horizontal bar chart built FROM the grounded table values, so it
 * adds no new fabrication surface. Returns null when the shape doesn't fit. */
function renderBarChart(header: string[], bodyRows: string[][]): string | null {
  if (header.length !== 2 || bodyRows.length < 2) return null;
  const values = bodyRows.map((r) => parseChartValue(r[1] ?? ''));
  if (values.some((v) => v === null || (v as number) < 0)) return null;
  const nums = values as number[];
  const max = Math.max(...nums);
  if (!(max > 0)) return null;
  const rows = bodyRows.slice(0, CHART_MAX_ROWS).map((r, i) => {
    const label = cellPlainText(r[0] ?? '');
    const valueText = cellPlainText(r[1] ?? '');
    const pct = Math.max(1, Math.round(((nums[i] as number) / max) * 1000) / 10);
    return (
      `<div class="answer-chart-row">` +
      `<span class="answer-chart-label" title="${label}">${label}</span>` +
      `<span class="answer-chart-track"><span class="answer-chart-bar" style="width:${pct}%"></span></span>` +
      `<span class="answer-chart-value">${valueText}</span>` +
      `</div>`
    );
  });
  const more =
    bodyRows.length > CHART_MAX_ROWS
      ? `<div class="answer-chart-more">+${bodyRows.length - CHART_MAX_ROWS} more</div>`
      : '';
  return `<div class="answer-chart" role="img" aria-label="Bar chart of ${header[1]} by ${header[0]}">${rows.join('')}${more}</div>`;
}

/** GFM pipe table → <table>. Requires a header row followed by a dash
 * delimiter row (so ordinary prose containing a stray `|` is never a
 * table). Cells carry full inline rendering (chips, bold, code). A numeric
 * 2-column breakdown also gets an inline bar chart rendered from its values. */
function renderTable(lines: string[]): string {
  const header = splitRow(lines[0] as string);
  const bodyRows = lines.slice(2).map(splitRow);
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join('');
  const trs = bodyRows
    .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  const table = `<table class="answer-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  const chart = renderBarChart(header, bodyRows);
  return chart !== null ? chart + table : table;
}

function renderBlock(block: string): string {
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return '';

  if (lines.length >= 2 && lines[0]?.includes('|') && TABLE_DELIM_RE.test(lines[1] as string)) {
    return renderTable(lines);
  }

  if (lines.every((l) => ORDERED_RE.test(l))) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(ORDERED_RE, ''))}</li>`).join('');
    return `<ol>${items}</ol>`;
  }
  if (lines.every((l) => BULLET_RE.test(l))) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(BULLET_RE, ''))}</li>`).join('');
    return `<ul>${items}</ul>`;
  }
  // Headings render as a bold paragraph — chat answers shouldn't shout in h-tags.
  const rendered = lines.map((l) => {
    if (HEADING_RE.test(l)) return `<strong>${renderInline(l.replace(HEADING_RE, '').trim())}</strong>`;
    return renderInline(l);
  });
  return `<p>${rendered.join('<br>')}</p>`;
}

/** Render an agent answer to safe HTML. */
export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text.trim());
  return escaped
    .split(/\n\s*\n/)
    .map(renderBlock)
    .filter((b) => b !== '')
    .join('');
}
