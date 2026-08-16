/**
 * dsh-cost-estimate — estimate token usage and DeepSeek API cost BEFORE the
 * model answers, shown as an inline row in the Web chat stream, then updated
 * with the actual provider-reported usage.
 *
 * Host face: no host behavior is needed in v1 — the computation and rendering
 * live entirely in the client face (lib/client.js, wired through the
 * `dsh.client` manifest). This entry exists so the bundle row loads cleanly
 * on the host plane and the package's `./client` face joins the browser
 * roster through its `dsh.client` declaration.
 */

/** Stable Cordis plugin name (must match the id used in the bundle patch). */
const name = "cost-estimate";

/** No host services required in v1. */
const inject = [];

/** Host body is intentionally a no-op; see the module doc. */
function apply() {}

export { apply, inject, name };
