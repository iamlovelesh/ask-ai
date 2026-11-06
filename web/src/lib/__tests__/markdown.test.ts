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

  it('renders a markdown pipe table as <table> with header and body rows', () => {
    const html = renderMarkdown(
      'Top invoices:\n\n| Invoice | Owed |\n| --- | --- |\n| INV-2687 | $10,511.42 |\n| INV-2003 | $9,558.65 |',
    );
    expect(html).toContain('<table');
    expect(html).toContain('<th>Invoice</th>');
    expect(html).toContain('<th>Owed</th>');
    expect(html).toContain('<td>INV-2687</td>');
    expect(html).toContain('<td>$10,511.42</td>');
    // the delimiter row (---) must not become a body row
    expect(html).not.toContain('<td>---</td>');
  });

  it('renders inline markup and record chips inside table cells', () => {
    const html = renderMarkdown(
      '| Who | Note |\n| --- | --- |\n| [[record:contacts:con_7:Ada]] | **urgent** |',
    );
    expect(html).toContain('record-chip');
    expect(html).toContain('<strong>urgent</strong>');
  });

  it('does not treat a single piped prose line as a table', () => {
    const html = renderMarkdown('Use the format Name | Email when exporting.');
    expect(html).not.toContain('<table');
    expect(html).toContain('<p>');
  });

  it('renders an inline bar chart for a 2-column numeric breakdown, keeping the table', () => {
    const html = renderMarkdown(
      'Leads by status:\n\n| Status | Count |\n| --- | --- |\n| new | 1,362 |\n| contacted | 1,252 |\n| qualified | 681 |',
    );
    expect(html).toContain('answer-chart');
    expect(html).toContain('<table'); // table still rendered
    // the largest value (1,362) fills the bar; a smaller one is proportionally shorter
    expect(html).toMatch(/width:\s*100(\.0)?%/);
    expect(html).toContain('1,362'); // original value label preserved
    // bar count = body rows
    expect((html.match(/answer-chart-bar/g) || []).length).toBe(3);
  });

  it('does NOT chart a 2-column table whose second column is non-numeric', () => {
    const html = renderMarkdown('| Who | Role |\n| --- | --- |\n| Ada | Admin |\n| Ben | Member |');
    expect(html).not.toContain('answer-chart');
    expect(html).toContain('<table');
  });

  it('does NOT chart a 3-column table', () => {
    const html = renderMarkdown('| Invoice | Owed | Owner |\n| --- | --- | --- |\n| INV-1 | $10 | Ada |\n| INV-2 | $20 | Ben |');
    expect(html).not.toContain('answer-chart');
  });

  it('chart labels strip record-chip tokens to the plain display name', () => {
    const html = renderMarkdown(
      '| Owner | Deals |\n| --- | --- |\n| [[record:users:user_2:Nora Haddad]] | 12 |\n| [[record:users:user_6:Marcus Kowalski]] | 8 |',
    );
    expect(html).toContain('answer-chart');
    expect(html).toContain('Nora Haddad');
    expect(html).not.toMatch(/answer-chart[\s\S]*\[\[record:/); // no raw token inside the chart
  });

  it('degrades a malformed record token to plain display-name text, not a broken span', () => {
    // entity/id that do not fit the safe charset must not emit a chip span
    const html = renderMarkdown('See [[record:Bad Entity:not an id:Ada Lovelace]] for details.');
    expect(html).not.toContain('record-chip');
    expect(html).toContain('Ada Lovelace');
    expect(html).not.toContain('[[record');
  });

  it('record chips escape malicious display names', () => {
    const html = renderMarkdown('[[record:leads:lead_1:<img src=x onerror=1>]]');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
