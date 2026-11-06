/**
 * Unknown-tool rescue (round-7b N1).
 *
 * With the catalog riding in the system prompt, the model sometimes calls a
 * catalog action by name WITHOUT binding it via catalog__search_actions
 * first — and the Agents SDK treats an unknown tool name as a fatal
 * ModelBehaviorError, killing the whole turn (live evidence: 6 production
 * turn deaths on `contacts__get_contact_details` / `email.search_email_messages`).
 *
 * The Runner captures its tool lookup map BEFORE the model call, so binding
 * during the response is too late for the current turn. Instead we repair the
 * response itself, at the model boundary, before the Runner resolves it:
 *  - a dot-form name whose `__` twin is bound is renamed in place;
 *  - any other unknown name becomes a catalog__search_actions call for that
 *    capability — the search binds the matching action, and the model
 *    completes the real call on its next step.
 */

const SEARCH_TOOL = 'catalog__search_actions';

interface FunctionCallItem {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/**
 * Repair unknown tool-call names in a model response's output items.
 * Items are replaced (not mutated) inside the given array. Returns the
 * number of rescued calls so callers can log the event.
 */
export function rescueToolCalls(output: unknown[], knownNames: ReadonlySet<string>): number {
  let rescued = 0;
  for (let i = 0; i < output.length; i += 1) {
    const item = output[i] as FunctionCallItem;
    if (item?.type !== 'function_call' || typeof item.name !== 'string') continue;
    if (knownNames.has(item.name)) continue;

    const normalized = item.name.replace(/\./g, '__');
    if (knownNames.has(normalized)) {
      output[i] = { ...item, name: normalized };
      rescued += 1;
      continue;
    }

    const query = item.name.replace(/[._]+/g, ' ').trim();
    output[i] = { ...item, name: SEARCH_TOOL, arguments: JSON.stringify({ query }) };
    rescued += 1;
  }
  return rescued;
}
