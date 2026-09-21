// Pre-flight context-window guard.
//
// A request whose prompt plus requested completion exceeds the model's context
// window is rejected by the upstream with a deterministic 400 ("maximum context
// length is N … you requested M"). Retrying that payload — on another account or
// the same one — reproduces the exact same 400, so it must never enter the
// fallback/lock loop (see ERROR_RULES.noFallback). This guard acts before
// dispatch so the recoverable cases are handled locally instead:
//
//   • prompt fits, but prompt + requested completion overflows → clamp the
//     completion ceiling down so the request still succeeds.
//   • prompt alone overflows, and the body has a `messages` array (OpenAI/
//     Claude-style wire shape) → drop the oldest whole conversation turns
//     until it fits, so the request still lands instead of dying outright.
//     A mismatch between what the client thinks the model's window is (e.g.
//     Claude Code assuming 1M) and the real, smaller window is common enough
//     that silently eating a 400 here is worse than continuing on a trimmed
//     conversation — the caller logs a warning so it's visible, not silent.
//   • prompt alone overflows and nothing more can be dropped (single turn
//     left, still over — or a wire shape this guard doesn't parse) → reject
//     with an actionable message instead of a doomed upstream call.
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

// estimateBodyTokens is a chars/4 heuristic, not the upstream's real tokenizer
// — accented text, punctuation-heavy content and per-provider serialization
// overhead all skew the real count higher than ours. Targeting the literal
// window leaves zero room for that error: a request estimated to just barely
// fit can still bounce off the exact same deterministic 400 this guard exists
// to avoid. Every trim/clamp decision targets this margined window instead of
// the raw one; only the final "nothing left to drop" reject uses the real
// window in its message, since by then the estimate's precision no longer
// changes the outcome.
const CONTEXT_SAFETY_MARGIN = 0.9;

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
 * A `role: "user"` message that carries nothing but tool_result blocks (Claude
 * wire shape: a tool result is relayed back as a user-role message) is not a
 * real turn boundary — it belongs with the assistant turn that requested it.
 * OpenAI-shape tool results use `role: "tool"`, which is never role "user", so
 * this only needs to special-case the Claude block shape.
 */
function isToolResultOnlyMessage(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) return false;
  return msg.content.every((block) => block && typeof block === "object" && block.type === "tool_result");
}

/**
 * Group a `messages` array into droppable turns: a leading run of
 * system/developer messages is kept as a fixed prefix (never dropped), then
 * each real user message (see isToolResultOnlyMessage) starts a new turn that
 * collects every message up to the next one. This keeps tool_use/tool_call
 * messages glued to the tool results answering them, since those never start
 * a new turn on their own — dropping a turn can never orphan a tool call/result.
 */
function groupIntoTurns(messages) {
  let i = 0;
  while (i < messages.length && (messages[i]?.role === "system" || messages[i]?.role === "developer")) i++;
  const prefix = messages.slice(0, i);

  const turns = [];
  let current = null;
  for (; i < messages.length; i++) {
    const msg = messages[i];
    const isBoundary = msg?.role === "user" && !isToolResultOnlyMessage(msg);
    if (isBoundary || current === null) {
      current = [];
      turns.push(current);
    }
    current.push(msg);
  }
  return { prefix, turns };
}

/**
 * Drop the oldest whole turns from `body.messages` (mutates `body` in place)
 * until the estimated prompt fits under `contextWindow`, or only the most
 * recent turn is left (nothing further to salvage — the caller rejects).
 * A no-op (returns turnsDropped: 0) when `body.messages` isn't the
 * OpenAI/Claude-style array this guard knows how to parse — e.g. Gemini
 * `contents` or Responses `input` — so those wire shapes fall straight through
 * to the existing reject behavior instead of risking a malformed trim.
 */
function trimOldestTurns(body, contextWindow) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { estimatedPrompt: estimateBodyTokens(body), turnsDropped: 0 };
  }

  const { prefix, turns } = groupIntoTurns(body.messages);
  let turnsDropped = 0;
  let estimatedPrompt = estimateBodyTokens(body);
  while (estimatedPrompt >= contextWindow && turns.length > 1) {
    turns.shift();
    turnsDropped++;
    body.messages = [...prefix, ...turns.flat()];
    estimatedPrompt = estimateBodyTokens(body);
  }
  return { estimatedPrompt, turnsDropped };
}

/**
 * Enforce the model's context window on a translated request body (mutates
 * `body` in place when clamping or trimming).
 *
 * @param {object} body - translated request body (already in the upstream format)
 * @param {number} contextWindow - model's total context window in tokens
 * @returns {{ action: "ok"|"clamped"|"trimmed"|"reject", estimatedPrompt: number,
 *             contextWindow: number, requestedOutput?: number,
 *             clampedTo?: number, turnsDropped?: number, message?: string }}
 */
export function enforceContextWindow(body, contextWindow) {
  if (!body || typeof body !== "object" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { action: "ok", estimatedPrompt: 0, contextWindow };
  }

  let estimatedPrompt = estimateBodyTokens(body);
  const requested = readOutputCeiling(body);
  const requestedOutput = requested?.value || 0;
  let turnsDropped = 0;
  const effectiveWindow = Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN);

  // Prompt alone already exceeds the margined window: try dropping the oldest
  // whole turns first (see trimOldestTurns) — this is the common case when the
  // client's own idea of the model's window (e.g. Claude Code assuming 1M)
  // doesn't match the real, smaller window and it never auto-compacted.
  if (estimatedPrompt >= effectiveWindow) {
    const trimmed = trimOldestTurns(body, effectiveWindow);
    turnsDropped = trimmed.turnsDropped;
    estimatedPrompt = trimmed.estimatedPrompt;

    // Still over — either nothing was droppable (single turn already, or a
    // wire shape this guard doesn't parse) or even the last turn alone
    // overflows. Nothing left to salvage — reject up front. The wording
    // deliberately carries "maximum context length" so the ERROR_RULES
    // noFallback rule classifies this locally-detected overflow the same way
    // it classifies the upstream one — otherwise this reject would be read as
    // a transient 400 and lock the account.
    if (estimatedPrompt >= effectiveWindow) {
      return {
        action: "reject",
        estimatedPrompt,
        contextWindow,
        requestedOutput,
        turnsDropped,
        message:
          `Request exceeds the model's maximum context length: prompt is ~${estimatedPrompt} ` +
          `tokens but the context window is ${contextWindow}. Reduce the conversation size ` +
          `or use a model with a larger context window.`,
      };
    }
  }

  // Prompt fits, but prompt + completion overflows: claw the completion back so
  // the request still lands inside the margined window.
  if (requested && estimatedPrompt + requestedOutput > effectiveWindow) {
    const clampedTo = effectiveWindow - estimatedPrompt;
    body[requested.key] = clampedTo;
    return { action: "clamped", estimatedPrompt, contextWindow, requestedOutput, clampedTo, turnsDropped };
  }

  return { action: turnsDropped > 0 ? "trimmed" : "ok", estimatedPrompt, contextWindow, requestedOutput, turnsDropped };
}
