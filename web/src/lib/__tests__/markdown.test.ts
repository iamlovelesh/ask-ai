import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown.js';

describe('renderMarkdown', () => {
  it('escapes HTML before anything else (XSS-safe)', () => {
    const html = renderMarkdown('<script>alert(1)</script> & <img src=x onerror=y>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('renders **bold** and `code`', () => {
    const html = renderMarkdown('You have **224 leads** via `leads.search`');
    expect(html).toContain('<strong>224 leads</strong>');
    expect(html).toContain('<code>leads.search</code>');
  });

  it('renders numbered lists as <ol><li>', () => {
    const html = renderMarkdown('Here:\n\n1. **Lead one** — a\n2. **Lead two** — b\n3. Lead three');
    expect(html).toContain('<ol>');
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
    expect(html).toContain('<strong>Lead one</strong>');
  });

  it('renders dash bullets as <ul><li>', () => {
    const html = renderMarkdown('- first\n- second');
    expect(html).toContain('<ul>');
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it('turns blank-line-separated text into paragraphs and keeps single newlines as breaks', () => {
    const html = renderMarkdown('Para one line A\nline B\n\nPara two');
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
    expect(html).toContain('line A<br>line B');
  });

  it('renders ### headings as bold paragraphs, not giant h-tags', () => {
    const html = renderMarkdown('### Summary\n\ntext');
    expect(html).toContain('<strong>Summary</strong>');
    expect(html).not.toContain('<h3>');
  });

  it('plain text passes through wrapped in a paragraph', () => {
    expect(renderMarkdown('All done.')).toBe('<p>All done.</p>');
  });

  it('renders [[record:entity:id:Name]] tokens as record chips (pattern)', () => {
    const html = renderMarkdown('The oldest is [[record:invoices:inv_55:INV-2667]] from May.');
    expect(html).toContain('class="record-chip"');
    expect(html).toContain('INV-2667');
    expect(html).toContain('data-record="invoices/inv_55"');
    expect(html).not.toContain('[[record:');
  });

  it('record chips escape malicious display names', () => {
    const html = renderMarkdown('[[record:leads:lead_1:<img src=x onerror=1>]]');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
