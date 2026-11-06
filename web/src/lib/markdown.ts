/**
 * Minimal, XSS-safe markdown renderer for agent answers.
 *
 * The loop model writes light markdown (bold, inline code, numbered/bullet
 * lists, occasional ### headings); the chat view used to interpolate it as
 * plain text, showing literal `**` to users. This renders exactly that
 * subset and nothing more — input is HTML-escaped FIRST, and the only tags
 * this module can emit are <p> <br> <strong> <em> <code> <ol> <ul> <li>,
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
  return escaped.replace(
    /\[\[record:([a-z_]+):([a-z_]+_\d+):((?:(?!\]\])[^\n])+)\]\]/g,
    (_m, entity: string, id: string, name: string) =>
      `<span class="record-chip" data-record="${entity}/${id}" title="${id}">${name}</span>`,
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

/** GFM pipe table → <table>. Requires a header row followed by a dash
 * delimiter row (so ordinary prose containing a stray `|` is never a
 * table). Cells carry full inline rendering (chips, bold, code). */
function renderTable(lines: string[]): string {
  const header = splitRow(lines[0] as string);
  const bodyRows = lines.slice(2).map(splitRow);
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join('');
  const trs = bodyRows
    .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="answer-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
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
