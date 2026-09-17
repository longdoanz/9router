// Pre-flight context-window guard.
//
// A request whose prompt plus requested completion exceeds the model's context
// window is rejected by the upstream with a deterministic 400 ("maximum context
// length is N … you requested M"). Retrying that payload — on another account or
// the same one — reproduces the exact same 400, so it must never enter the
// fallback/lock loop (see ERROR_RULES.noFallback). This guard acts before
// dispatch so the two recoverable cases are handled locally instead:
//
//   • prompt fits, but prompt + requested completion overflows → clamp the
//     completion ceiling down so the request still succeeds (trim).
//   • prompt alone already overflows → no amount of clamping helps, so reject
//     immediately with an actionable message instead of a doomed upstream call.
//
// Nothing happens when the whole request already fits, so requests that work
// today are never touched.

import { DEFAULT_CAPABILITIES } from "../../providers/capabilities.js";

// CJK chars encode to more tokens than the chars/4 rule assumes (CJK ~1 token
// each); the same heuristic the qoder context-tier picker uses.
const CJK_RE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/g;

/**
 * Whether `contextWindow` is a real per-model value rather than the generic
 * DEFAULT_CAPABILITIES floor (200000) returned for a model we have no data on.
 * Acting on the floor would reject/trim requests for a model whose true window
 * is larger; those are left to the upstream, whose overflow 400 the noFallback
 * rule already keeps out of the lock loop.
 */
export function isKnownContextWindow(contextWindow) {
  return Number.isFinite(contextWindow) && contextWindow > 0 && contextWindow !== DEFAULT_CAPABILITIES.contextWindow;
}

// Keys that carry the completion ceiling, in precedence order.
const OUTPUT_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

/**
 * Rough token count for a translated request body. Format-agnostic: serializes
 * the body and counts CJK chars as ~1 token and everything else as ~4 chars.
 * The upstream 400 remains the authority — this only needs to be close enough
 * to keep an overflowing request off the wire.
 */
export function estimateBodyTokens(body) {
  let text;
  try {
    text = JSON.stringify(body) || "";
  } catch {
    return 0;
  }
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function readOutputCeiling(body) {
  for (const key of OUTPUT_KEYS) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return { key, value: v };
  }
  // A model may also declare reasoning/thinking budgets that count against the
  // window; not modelled here — this is a floor, not an exact accounting.
  return null;
}

/**
 * Enforce the model's context window on a translated request body (mutates
 * `body` in place when clamping).
 *
 * @param {object} body - translated request body (already in the upstream format)
 * @param {number} contextWindow - model's total context window in tokens
 * @returns {{ action: "ok"|"clamped"|"reject", estimatedPrompt: number,
 *             contextWindow: number, requestedOutput?: number,
 *             clampedTo?: number, message?: string }}
 */
export function enforceContextWindow(body, contextWindow) {
  if (!body || typeof body !== "object" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { action: "ok", estimatedPrompt: 0, contextWindow };
  }

  const estimatedPrompt = estimateBodyTokens(body);
  const requested = readOutputCeiling(body);
  const requestedOutput = requested?.value || 0;

  // Prompt alone already exceeds the window: trimming the completion to zero
  // still leaves it over, so there is nothing to salvage — reject up front.
  // The wording deliberately carries "maximum context length" so the
  // ERROR_RULES noFallback rule classifies this locally-detected overflow the
  // same way it classifies the upstream one — otherwise this reject would be
  // read as a transient 400 and lock the account.
  if (estimatedPrompt >= contextWindow) {
    return {
      action: "reject",
      estimatedPrompt,
      contextWindow,
      requestedOutput,
      message:
        `Request exceeds the model's maximum context length: prompt is ~${estimatedPrompt} ` +
        `tokens but the context window is ${contextWindow}. Reduce the conversation size ` +
        `or use a model with a larger context window.`,
    };
  }

  // Prompt fits, but prompt + completion overflows: claw the completion back so
  // the request still lands inside the window.
  if (requested && estimatedPrompt + requestedOutput > contextWindow) {
    const clampedTo = contextWindow - estimatedPrompt;
    body[requested.key] = clampedTo;
    return { action: "clamped", estimatedPrompt, contextWindow, requestedOutput, clampedTo };
  }

  return { action: "ok", estimatedPrompt, contextWindow, requestedOutput };
}
