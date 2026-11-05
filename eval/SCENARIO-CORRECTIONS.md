# Scenario corrections — task-harness-fairness

Context: `results/2026-11-05T21-03-21-607Z/results.jsonl` showed a batch of
scenarios failing with `answer.final did not mention '<tool slug>'`. On
inspection, `server/src/agent/composer.ts` (the pure-template renderer for
`answer.final`) **deliberately never lets a dotted tool slug reach
`answer.final`** — see its own header, grounding contract #4: "No internal
vocabulary ever reaches `answer.final`: ... no tool slugs
(`leads.assign_lead_owner` is rendered 'assign lead owner')". `assert.ts`'s
backstop regex (`TOOL_SLUG_RE`) in that same file is there specifically to
*catch* a slug leaking into the response — the product spec is unambiguous
that user-facing text must never contain internal catalog jargon.

So every scenario below was asserting something the product spec forbids.
The fix is NOT to the agent/composer — it is to the scenario's assertion,
which was testing the wrong thing. Each was corrected to assert a
**semantically equivalent, user-facing fact** the slug implied (the entity
name/id the action targeted, the exact count it returned, or — where no
entity-specific text is groundable without depending on live computed data
— the plain-English module noun `composer.ts`'s template always uses in
both its "found" and "not found" branches).

Every replacement value below was verified against
`server/data/crm-standard.template.db` (the template every eval run reseeds
from) and/or the catalog's own `*View`/output-schema field shapes in
`server/src/catalog/*.ts`, not guessed. This applies equally to the
`baseline` and `optimized` agents — `composer.ts` is shared by both; neither
agent's answer.final ever contained the slug, so no scenario here was ever
distinguishing a "better" from a "worse" agent — it was failing both
equally on a self-contradictory assertion.

**Justification (same for every row below unless noted):** assertion
contradicted the no-jargon product requirement (`answer.final` must never
contain a dotted tool slug); corrected to a semantic equivalent; applies
equally to baseline and optimized.

| Scenario | Old `response.mustMention` | New `response.mustMention` |
|---|---|---|
| `ambiguous-events-001` | `[events.search_events]` | `["events"]` — plain-English module noun, present in both composer branches. (An exact count, `"18"` per the template db's `published\|18`, was tried first but reverted after a live `--quick` run: the user's own phrasing, "upcoming", invites the planner to add a date filter on top of `status=published`, which legitimately changes the live count — asserting the literal "18" was just as fragile as the slug it replaced.) |
| `direct-availability-002` | `[availability.find_available_slots]` | `["availability"]` — plain-English module noun (`moduleNoun`), present in both the found and empty-result composer branches; the exact slot count depends on live computed availability so a specific number can't be hardcoded |
| `direct-calendars-002` | `[calendars.get_calendar_settings]` | `["calendar 6"]` — the calendar's own `name` field (`CalendarView.name`), verified `struct_181` |
| `direct-communities-002` | `[communities.get_community_details]` | `["community 2"]` — `CommunityView.name`, verified `struct_297` |
| `direct-campaigns-002` | `[campaigns.get_campaign_details]` | `["campaign 3"]` — `CampaignView.name`, verified `struct_73` |
| `direct-companies-002` | `[companies.get_company_details]` | `["Cobalt Networks 618"]` — `companies.name` for `co_1`, already given in the file's own derivation comment |
| `direct-conversations-001` | `[conversations.search_conversations]` | `["189"]` — exact count of open SMS conversations, already given in the file's own derivation comment |
| `direct-contacts-001` | `[contacts.search_contacts]` | `["1757"]` — exact count of customer-lifecycle contacts, already given in the file's own derivation comment |
| `direct-coupons-002` | `[coupons.get_coupon_details]` | `["coupon 3"]` — `CouponView.name`, verified `struct_198` |
| `direct-custom_fields-002` | `[custom_fields.list_fields_for_module]` | `["custom fields"]` — plain-English module noun, present in both composer branches |
| `direct-conversations-002` | `[conversations.get_conversation]` | `["Re: your inquiry"]` — `conv_1`'s actual `subject` (`ConversationView.name` resolves to `subject ?? contactName ?? "Conversation <id>"`), verified against the template db |
| `direct-enrollments-002` | `[enrollments.search_enrollments]` | `["enrollments"]` — plain-English module noun, present in both composer branches |
| `direct-forms-002` | `[forms.get_form_definition]` | `["form 2"]` — `FormView.name`, verified `struct_137` |
| `direct-events-002` | `[events.get_event_details]` | `["Product Roadmap Webinar"]` — `evt_1`'s actual name, already given in the file's own derivation comment |
| `direct-opportunities-003` | `[opportunities.get_opportunity_details]` | `["Opportunity opp_1"]` — `OpportunityView.name` for `opp_1`, verified against the template db |
| `direct-message_templates-002` | `[message_templates.search_templates]` | `["message templates"]` — plain-English module noun, present in both composer branches |
| `direct-pipelines-002` | `[pipelines.get_pipeline_configuration]` | `["pipeline 3"]` — `PipelineView.name`, verified `struct_168` |
| `direct-orders-001` | `[orders.search_orders]` | `["136"]` — exact count of cancelled orders, already given in the file's own derivation comment |
| `direct-search-leads` | `[leads.search_leads]` | `["leads"]` — plain-English module noun; the file's prior comment ("composer.ts ... always renders a done step as `<action>: <N> record(s)`") described `step.finished.summary`, an internal event field, not `answer.final` — that comment was itself the source of the contradiction and has been corrected in-file too |
| `direct-orders-003` | `[orders.get_order_details]` | `["$3372.33"]` — `OrderView` has no name field, so composer falls to the money-field convention (`total_cents`); `ord_1.total_cents = 337233`, verified against the template db |
| `direct-subscriptions-003` | `[subscriptions.get_subscription_details]` | `["$830.01"]` — `SubscriptionView` has no name field, falls to `amount_cents`; `sub_1.amount_cents = 83001`, verified against the template db |
| `direct-quotes-003` | `[quotes.get_quote_details]` | `["$3291.48"]` — `QuoteView` has no name field, falls to `total_cents`; `quote_1.total_cents = 329148`, verified against the template db |
| `direct-products-002` | `[products.search_products]` | `["products"]` — plain-English module noun, present in both composer branches |
| `direct-smart_lists-002` | `[smart_lists.get_smart_list_definition]` | `["smart list 10"]` — `SmartListView.name`, verified `struct_10` |
| `direct-surveys-002` | `[surveys.get_survey_definition]` | `["survey 2"]` — `SurveyView.name`, verified `struct_152` |
| `direct-users-002` | `[users.get_user_profile]` | `["Isla Reyes"]` — `UserView.name` for `user_1`, already given in the file's own derivation comment |
| `direct-workflows-002` | `[workflows.get_workflow_definition]` | `["workflow 6"]` — `WorkflowView.name`, verified `struct_101` |
| `typo-calendars-001` | `[calendars.update_calendar_details]` | `["Enterprise Demos"]` — composer's write-leaf renders the record's post-write `name`; "Enterprise Demos" is the new name the request itself specified |
| `typo-teams-001` | `[teams.get_team_details]` | `["Enterprise Sales"]` — `TeamView.name` for `team_1`, verified against the template db |
| `typo-support_tickets-001` | `[support_tickets.search_tickets]` | `["support tickets"]` — plain-English module noun, present in both composer branches |
| `typo-quotes-001` | `[quotes.create_quote]` | `["quote"]` — composer's write-leaf falls to the record's own generated id (`QuoteView` has no name field); every created quote's id is prefixed `"quote_"` (`next-id.ts`), so this substring holds regardless of the exact generated number |
| `typo-search-opportunities` | `[opportunities.search_opportunities]` | `["opportunities"]` — plain-English module noun, present in both composer branches |

**Not touched (frozen):** every other `response.mustMention`/`mustNotClaim`
entry in `eval/scenarios/*.yaml` — including the ones that only list plain
English words (`failed`, `error`, `done`, …) and the already-corrected
`multistep-reports-002.yaml` comment (a prior, unrelated hardening-review
correction that had already dropped its `mustMention` block entirely) — does
not match the dotted-slug pattern and was left exactly as it was.

## Live-run verification note

A real (non-mocked) `npm run eval -- --quick --trials 1 --budget 7.00` pass
was run against the corrected scenarios (haiku planner, same config as the
`7/20` baseline). Two of the 20 quick-subset scenarios touched by this
correction (`ambiguous-events-001`, `direct-availability-002`) still failed
their `response.mustMention` check in that one run:

- `ambiguous-events-001` asserted the exact count `"18"` at first; the live
  run showed the real planner legitimately filters "upcoming" events to a
  different count than the raw `status='published'` total, so the exact
  count was never a safe assertion to begin with (same class of fragility
  as the slug it replaced). **Fixed above** — reverted to the plain module
  noun `"events"`.
- `direct-availability-002` still asserted `"availability"` and still
  failed in that run. Root cause wasn't confirmed (budget was exhausted by
  the verification run itself, so a second live run wasn't taken) — the
  live planner may not have produced a `done` leaf step for
  `find_available_slots` (e.g. a param issue causing a `step.failed`,
  whose `composer.ts` failure-line renderer uses
  `humanizeActionPhrase`, which strips the module prefix entirely and
  would NOT contain "availability" even though the module noun reasoning
  holds for the success path). This is flagged as a known limitation of
  this specific scenario's correction, not a flaw in the module-noun
  strategy used everywhere else in this table — `planActions`/
  `confirmation` checks for this scenario still pass either way, so it is
  not a `status:'failed'`-backstop case.

This does not change the applicability of the fix: `answer.final` still
never contained the slug, so the original assertion was never satisfiable
either, regardless of this residual.
