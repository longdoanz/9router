// Claude Code appends a bracketed context marker to the model name when the
// 1M-context beta is toggled on: `claude-opus-5` becomes `claude-opus-5[1m]`.
// The marker is a client-side annotation, not part of any model id: it never
// matches a combo name, an alias or a `provider/model` pair, so a request that
// carries it dies at model resolution with "Invalid model format".
//
// The capability itself travels in the `anthropic-beta: context-1m-2025-08-07`
// header, which is forwarded untouched — stripping the marker is enough to let
// the request route normally and still reach the upstream as a 1M request.

const CONTEXT_MARKER = /\[1m\]$/i;

// Returns { model, contextMarker } — contextMarker is null when there is none.
export function stripModelContextMarker(modelStr) {
  if (typeof modelStr !== "string") return { model: modelStr, contextMarker: null };
  const trimmed = modelStr.trim();
  const match = trimmed.match(CONTEXT_MARKER);
  if (!match) return { model: modelStr, contextMarker: null };
  return { model: trimmed.slice(0, -match[0].length), contextMarker: match[0].slice(1, -1).toLowerCase() };
}

// A combo entry can pin its provider ACCOUNT by appending the connection id:
//   "cc/claude-opus-4-5@3f2a9c1e-...."  → route this entry to that connection
// Like the context marker above, the pin is an annotation on the model string, not
// part of any model id — it is stripped at model resolution so it never reaches an
// upstream. The pin travels on the combo entry itself, which keeps handleComboChat's
// `handleSingleModel(body, modelStr)` contract unchanged. `@` appears in no model id.
const ACCOUNT_PIN = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Returns { model, connectionId } — connectionId is null when there is no pin.
// Only a trailing UUID is treated as a pin, so an unrelated "@" in a model id
// (there are none today) falls through untouched.
export function parseAccountPin(modelStr) {
  if (typeof modelStr !== "string") return { model: modelStr, connectionId: null };
  const match = modelStr.match(ACCOUNT_PIN);
  if (!match) return { model: modelStr, connectionId: null };
  return { model: modelStr.slice(0, -match[0].length), connectionId: match[1] };
}

// Append a pin to a model string; a null/empty connectionId clears any existing pin.
export function withAccountPin(model, connectionId) {
  const { model: bare } = parseAccountPin(model);
  return connectionId ? `${bare}@${connectionId}` : bare;
}
