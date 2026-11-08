/**
 * Pure helpers for the `session__request_form` path of ConfirmCard: deciding
 * whether a form is complete and collecting its submitted values.
 *
 * Why this exists: a `<input type="number">` bound with `v-model` stores a
 * NUMBER (not a string) in the reactive values map, so calling `.trim()` on a
 * raw value throws. These helpers coerce every value to a string before any
 * string op, then cast number fields back on collect — so the form is robust
 * to whatever type the input element hands back.
 */

export interface ConfirmFormField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  required: boolean;
}

/** The raw, trimmed string form of a reactive field value, regardless of
 * whether the input element produced a string, a number, or nothing. */
export function fieldString(value: unknown): string {
  return String(value ?? '').trim();
}

/** A form is complete when every REQUIRED field has a non-empty value. */
export function isFormComplete(
  fields: readonly ConfirmFormField[],
  values: Readonly<Record<string, unknown>>,
): boolean {
  return fields.every((fld) => !fld.required || fieldString(values[fld.key]) !== '');
}

/** Collects the non-empty field values, casting number fields back to numbers.
 * Empty fields are omitted entirely (the server treats absent as "not set"). */
export function collectFormValues(
  fields: readonly ConfirmFormField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const fld of fields) {
    const raw = fieldString(values[fld.key]);
    if (raw === '') continue;
    out[fld.key] = fld.type === 'number' ? Number(raw) : raw;
  }
  return out;
}
