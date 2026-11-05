/**
 * Human action names (Feature B). The authoritative map comes from
 * `GET /admin/catalog` (cached in `stores/catalog.ts`); this is the pure
 * fallback used before the catalog has loaded (or for a slug not in it):
 * strip the leading module segment and title-case the remaining
 * underscore-separated words into a sentence-case label.
 *
 * e.g. `invoices.search_invoices` → "Search invoices"
 *      `leads.assign_lead_owner`  → "Assign lead owner"
 *      `core.sort`                → "Sort"
 */

export function prettifySlug(slug: string): string {
  if (!slug) return slug;
  const segments = slug.split('.');
  // Drop the leading module segment (`invoices`, `leads`, …) when there's
  // more than one; a bare single-segment slug keeps all of it.
  const rest = segments.length > 1 ? segments.slice(1) : segments;
  const words = rest.join(' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return slug;
  // Sentence case — capitalize only the first letter (design-system
  // discipline: sentence case, never Title Case).
  return words.charAt(0).toUpperCase() + words.slice(1);
}
