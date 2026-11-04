/**
 * Static index of catalog modules (LLD repo layout: `m01-contacts.ts …
 * m50-reports.ts`). `registry.ts` imports ONLY this file for module
 * ActionDefs — adding a new module requires exactly one import line + one
 * array entry here, no edits to `registry.ts` itself.
 *
 * M02-M50 land in later tasks; M01 (contacts) is the Task 7/8 reference
 * module that proves the loading mechanism end-to-end.
 *
 * Every module ALSO exports (required, not optional — keeps this file's
 * import list uniform):
 *   - `discriminationChecks` (empty `[]` if it has no Tier-A
 *     filter-discrimination coverage yet — see discrimination.ts).
 *     `MODULE_DISCRIMINATION_CHECKS` flattens all of them for
 *     `eval/smoke.ts`.
 *   - `synthHints` (empty `{}` if its id-shaped fields all resolve against
 *     plain, non-kind-discriminated tables — see synth-hints.ts).
 *     `MODULE_SYNTH_HINTS` merges all of them (flat, keyed by field name)
 *     for `eval/smoke.ts`'s `synthesizeInput` calls.
 */

import type { ActionDef } from './types.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import { m01Contacts, m01DiscriminationChecks, m01SynthHints } from './m01-contacts.js';
import { m02Companies, m02DiscriminationChecks, m02SynthHints } from './m02-companies.js';
import { m03Leads, m03DiscriminationChecks, m03SynthHints } from './m03-leads.js';
import { m04Opportunities, m04DiscriminationChecks, m04SynthHints } from './m04-opportunities.js';
import { m05Pipelines, m05DiscriminationChecks, m05SynthHints } from './m05-pipelines.js';
import { m06Tasks, m06DiscriminationChecks, m06SynthHints } from './m06-tasks.js';
import { m07Notes, m07DiscriminationChecks, m07SynthHints } from './m07-notes.js';
import { m08Tags, m08DiscriminationChecks, m08SynthHints } from './m08-tags.js';
import { m09SmartLists, m09DiscriminationChecks, m09SynthHints } from './m09-smart_lists.js';
import { m10CustomFields, m10DiscriminationChecks, m10SynthHints } from './m10-custom_fields.js';
import { m11Conversations, m11DiscriminationChecks, m11SynthHints } from './m11-conversations.js';
import { m12Sms, m12DiscriminationChecks, m12SynthHints } from './m12-sms.js';
import { m13Email, m13DiscriminationChecks, m13SynthHints } from './m13-email.js';
import { m14MessageTemplates, m14DiscriminationChecks, m14SynthHints } from './m14-message_templates.js';
import { m15Campaigns, m15DiscriminationChecks, m15SynthHints } from './m15-campaigns.js';
import { m16Workflows, m16DiscriminationChecks, m16SynthHints } from './m16-workflows.js';
import { m17EventTriggers, m17DiscriminationChecks, m17SynthHints } from './m17-event_triggers.js';
import { m18Forms, m18DiscriminationChecks, m18SynthHints } from './m18-forms.js';
import { m19Surveys, m19DiscriminationChecks, m19SynthHints } from './m19-surveys.js';
import { m20Calendars, m20DiscriminationChecks, m20SynthHints } from './m20-calendars.js';
import { m21Appointments, m21DiscriminationChecks, m21SynthHints } from './m21-appointments.js';
import { m22Availability, m22DiscriminationChecks, m22SynthHints } from './m22-availability.js';
import { m23BookingPages, m23DiscriminationChecks, m23SynthHints } from './m23-booking_pages.js';
import { m24Events, m24DiscriminationChecks, m24SynthHints } from './m24-events.js';
import { m25Products, m25DiscriminationChecks, m25SynthHints } from './m25-products.js';
import { m26Prices, m26DiscriminationChecks, m26SynthHints } from './m26-prices.js';
import { m27Quotes, m27DiscriminationChecks, m27SynthHints } from './m27-quotes.js';
import { m28Invoices, m28DiscriminationChecks, m28SynthHints } from './m28-invoices.js';
import { m29Payments, m29DiscriminationChecks, m29SynthHints } from './m29-payments.js';
import { m30Subscriptions, m30DiscriminationChecks, m30SynthHints } from './m30-subscriptions.js';
import { m31Coupons, m31DiscriminationChecks, m31SynthHints } from './m31-coupons.js';
import { m32Orders, m32DiscriminationChecks, m32SynthHints } from './m32-orders.js';
import { m33Refunds, m33DiscriminationChecks, m33SynthHints } from './m33-refunds.js';
import { m34TaxRules, m34DiscriminationChecks, m34SynthHints } from './m34-tax_rules.js';

/** One entry per module file, in M01…M50 order. */
export const MODULE_ACTION_ARRAYS: readonly ActionDef[][] = [
  m01Contacts,
  m02Companies,
  m03Leads,
  m04Opportunities,
  m05Pipelines,
  m06Tasks,
  m07Notes,
  m08Tags,
  m09SmartLists,
  m10CustomFields,
  m11Conversations,
  m12Sms,
  m13Email,
  m14MessageTemplates,
  m15Campaigns,
  m16Workflows,
  m17EventTriggers,
  m18Forms,
  m19Surveys,
  m20Calendars,
  m21Appointments,
  m22Availability,
  m23BookingPages,
  m24Events,
  m25Products,
  m26Prices,
  m27Quotes,
  m28Invoices,
  m29Payments,
  m30Subscriptions,
  m31Coupons,
  m32Orders,
  m33Refunds,
  m34TaxRules,
];

/** One entry per module file's `discriminationChecks` export, flattened. */
export const MODULE_DISCRIMINATION_CHECKS: readonly DiscriminationCheck[] = [
  ...m01DiscriminationChecks,
  ...m02DiscriminationChecks,
  ...m03DiscriminationChecks,
  ...m04DiscriminationChecks,
  ...m05DiscriminationChecks,
  ...m06DiscriminationChecks,
  ...m07DiscriminationChecks,
  ...m08DiscriminationChecks,
  ...m09DiscriminationChecks,
  ...m10DiscriminationChecks,
  ...m11DiscriminationChecks,
  ...m12DiscriminationChecks,
  ...m13DiscriminationChecks,
  ...m14DiscriminationChecks,
  ...m15DiscriminationChecks,
  ...m16DiscriminationChecks,
  ...m17DiscriminationChecks,
  ...m18DiscriminationChecks,
  ...m19DiscriminationChecks,
  ...m20DiscriminationChecks,
  ...m21DiscriminationChecks,
  ...m22DiscriminationChecks,
  ...m23DiscriminationChecks,
  ...m24DiscriminationChecks,
  ...m25DiscriminationChecks,
  ...m26DiscriminationChecks,
  ...m27DiscriminationChecks,
  ...m28DiscriminationChecks,
  ...m29DiscriminationChecks,
  ...m30DiscriminationChecks,
  ...m31DiscriminationChecks,
  ...m32DiscriminationChecks,
  ...m33DiscriminationChecks,
  ...m34DiscriminationChecks,
];

/**
 * Every module file's `synthHints` export, merged flat (keyed by field
 * name). Later modules in `MODULE_ACTION_ARRAYS` order win on a field-name
 * collision — in practice field names are consistent catalog-wide (a
 * `coupon_id` means the same thing everywhere), so a collision signals two
 * modules disagreeing about a shared field's meaning and is worth a second
 * look, not something to silently paper over.
 */
export const MODULE_SYNTH_HINTS: Readonly<SynthHints> = {
  ...m01SynthHints,
  ...m02SynthHints,
  ...m03SynthHints,
  ...m04SynthHints,
  ...m05SynthHints,
  ...m06SynthHints,
  ...m07SynthHints,
  ...m08SynthHints,
  ...m09SynthHints,
  ...m10SynthHints,
  ...m11SynthHints,
  ...m12SynthHints,
  ...m13SynthHints,
  ...m14SynthHints,
  ...m15SynthHints,
  ...m16SynthHints,
  ...m17SynthHints,
  ...m18SynthHints,
  ...m19SynthHints,
  ...m20SynthHints,
  ...m21SynthHints,
  ...m22SynthHints,
  ...m23SynthHints,
  ...m24SynthHints,
  ...m25SynthHints,
  ...m26SynthHints,
  ...m27SynthHints,
  ...m28SynthHints,
  ...m29SynthHints,
  ...m30SynthHints,
  ...m31SynthHints,
  ...m32SynthHints,
  ...m33SynthHints,
  ...m34SynthHints,
};
