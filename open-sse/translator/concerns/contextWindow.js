// Pre-flight context-window guard, and the one history trimmer the rest of the
// engine shares.
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
//   • prompt alone overflows → drop whole conversation turns out of the MIDDLE
//     until it fits, so the request still lands instead of dying outright.
//     A mismatch between what the client thinks the model's window is (e.g.
//     Claude Code assuming 1M) and the real, smaller window is common enough
//     that silently eating a 400 here is worse than continuing on a trimmed
//     conversation — the caller logs a warning so it's visible, not silent.
//   • prompt alone overflows and nothing more can be dropped (one turn left and
//     still over) → reject with an actionable message instead of a doomed call.
//
// Nothing happens when the whole request already fits, so requests that work
// today are never touched.
//
// Why the middle and not the oldest first: prompt caching anchors on an exact
// prefix measured from the very start of the request. Dropping the oldest turns
// changes the bytes right after the system prompt, so every cached prefix is
// invalidated and each trimmed request pays full price. Keeping the system
// prefix plus the first HEAD_KEEP_TURNS turns verbatim leaves that whole span
// byte-identical across requests, so the cache still hits up to the first
// dropped turn. For the same reason, when the head itself has to give, it is
// shortened from its newest end — never from the front.

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

// Keys that carry the conversation list, one per wire shape: OpenAI/Claude
// `messages`, Responses `input`, Gemini `contents`.
const HISTORY_KEYS = ["messages", "input", "contents"];

/** Rough token count for a serialized string: CJK ~1 token each, rest ~4 chars. */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * Rough token count for a translated request body. Format-agnostic: serializes
 * the whole body, so tools/system/params are counted too, not just the history.
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
  return estimateTokens(text);
}

// estimateBodyTokens is a chars/4 heuristic, not the upstream's real tokenizer
// — accented text, punctuation-heavy content and per-provider serialization
// overhead all skew the real count higher than ours, and a completion still has
// to fit alongside the prompt. Targeting the literal window leaves zero room for
// either: a request estimated to just barely fit can still bounce off the exact
// same deterministic 400 this guard exists to avoid. Every trim/clamp decision
// targets this margined window instead of the raw one; only the final "nothing
// left to drop" reject reports the real window, since by then the estimate's
// precision no longer changes the outcome.
export const CONTEXT_SAFETY_MARGIN = 0.85;

// The trim splits the conversation into three zones, sized in tokens rather
// than turn counts — one turn can be a pasted file, so a count says nothing
// about what it costs.
//
//   head   — kept verbatim so the cacheable prefix reaches past the system
//            prompt. Worth at least one provider cache minimum (the largest in
//            use is 2048 tokens; below that the prefix isn't cacheable at all
//            and the head is pure dead weight), but capped: every token here is
//            stale context competing with the live conversation, and the cache
//            saving stops growing once the boundary is stable.
//   middle — the drop pool, shed oldest-first and only as far as needed.
//   tail   — a reserve of the most recent turns the middle sweep may not touch,
//            so trimming never eats the context being answered from.
const HEAD_CACHE_TOKENS_MIN = 2048;
const HEAD_BUDGET_RATIO = 0.15;
const HEAD_MAX_RATIO = 0.3;
const TAIL_RESERVE_RATIO = 0.5;

function readOutputCeiling(body) {
  for (const key of OUTPUT_KEYS) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return { key, value: v };
  }
  // A model may also declare reasoning/thinking budgets that count against the
  // window; not modelled here — this is a floor, not an exact accounting.
  return null;
}

/** Which wire shape carries this body's conversation, if any. */
function historyKey(body) {
  for (const key of HISTORY_KEYS) {
    if (Array.isArray(body?.[key]) && body[key].length > 0) return key;
  }
  return null;
}

function isSystemRole(role) {
  return role === "system" || role === "developer";
}

/**
 * A `role: "user"` entry carrying nothing but tool results is not a real turn
 * boundary — it belongs with the assistant turn that requested it. Claude
 * relays them as user-role messages of `tool_result` blocks and Gemini as
 * user-role `functionResponse` parts; OpenAI uses `role: "tool"` and Responses
 * a roleless `function_call_output`, neither of which is role "user", so they
 * are already non-boundaries.
 */
function isToolResultCarrier(msg) {
  if (!msg || msg.role !== "user") return false;
  const blocks = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : null;
  if (!blocks || blocks.length === 0) return false;
  return blocks.every((b) => b && typeof b === "object" && (b.type === "tool_result" || b.functionResponse));
}

/**
 * Group a conversation list into droppable turns: a leading run of
 * system/developer entries is kept as a fixed prefix (never dropped), then each
 * real user entry (see isToolResultCarrier) starts a new turn collecting every
 * entry up to the next one. Assistant/tool entries never start a turn, so a
 * tool call always leaves with the tool result answering it — dropping a turn
 * can never orphan one half of a pair (which upstreams reject with their own
 * 400).
 */
function groupIntoTurns(list) {
  let i = 0;
  while (i < list.length && isSystemRole(list[i]?.role)) i++;
  const prefix = list.slice(0, i);

  const turns = [];
  let current = null;
  for (; i < list.length; i++) {
    const msg = list[i];
    const isBoundary = msg?.role === "user" && !isToolResultCarrier(msg);
    if (isBoundary || current === null) {
      current = [];
      turns.push(current);
    }
    current.push(msg);
  }
  return { prefix, turns };
}

/**
 * Plan a history trim that brings `body` under `budgetTokens`, dropping whole
 * turns out of the middle. Pure — `body` is never mutated; the caller decides
 * whether to apply the new list in place or take the returned copy.
 *
 * Turns are shed oldest-of-the-middle first, keeping the system prefix, the
 * cacheable head and the recent-turn reserve (see the zone constants). When the
 * middle runs out the head gives way next — a lost cache is a cost and latency
 * hit, while lost recent context is a wrong answer — shortened from its newest
 * end so the surviving prefix stays as long as possible. Only after that does
 * the reserve itself get eaten, and the current turn never does.
 *
 * @param {object} body - request body in any supported wire shape
 * @param {number} budgetTokens - the already-margined ceiling to fit under
 * @returns {{ key: string, list: any[], body: object, turnsDropped: number,
 *             estimatedPrompt: number } | null} null when nothing was dropped
 *           (already fits, unparseable shape, or only one turn exists).
 */
export function planHistoryTrim(body, budgetTokens) {
  const key = historyKey(body);
  if (!key || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return null;

  const { prefix, turns } = groupIntoTurns(body[key]);
  if (turns.length <= 1) return null;

  let estimated = estimateBodyTokens(body);
  if (estimated < budgetTokens) return null;

  // Per-turn costs let us choose the drop set with one pass instead of
  // re-serializing the whole body after every single drop.
  const cost = turns.map((turn) => estimateTokens(JSON.stringify(turn)));
  const keep = turns.map(() => true);
  const lastIdx = turns.length - 1;

  // Head zone: turns [0, headEnd). Grown turn by turn while it stays inside the
  // head budget, so an oversized first turn simply doesn't qualify instead of
  // swallowing the window. Its boundary only moves when these early turns
  // change — which history never does — so the cached prefix stays stable
  // across every request in the conversation.
  const headBudget = Math.min(
    Math.max(HEAD_CACHE_TOKENS_MIN, Math.floor(budgetTokens * HEAD_BUDGET_RATIO)),
    Math.floor(budgetTokens * HEAD_MAX_RATIO),
  );
  let headEnd = 0;
  for (let i = 0, spent = 0; i < lastIdx && spent + cost[i] <= headBudget; i++) {
    spent += cost[i];
    headEnd = i + 1;
  }

  // Tail reserve: turns [tailStart, lastIdx]. Walked back from the current turn
  // while it fits the reserve budget, and never past headEnd.
  const tailBudget = Math.floor(budgetTokens * TAIL_RESERVE_RATIO);
  let tailStart = lastIdx;
  for (let i = lastIdx - 1, spent = cost[lastIdx]; i >= headEnd && spent + cost[i] <= tailBudget; i--) {
    spent += cost[i];
    tailStart = i;
  }

  let turnsDropped = 0;
  const drop = (i) => {
    if (!keep[i]) return;
    keep[i] = false;
    estimated -= cost[i];
    turnsDropped++;
  };
  // The middle, oldest first — the least valuable context to lose.
  for (let i = headEnd; i < tailStart && estimated >= budgetTokens; i++) drop(i);
  // Then the cacheable head, newest first, so its front survives longest.
  for (let i = headEnd - 1; i >= 0 && estimated >= budgetTokens; i--) drop(i);
  // Last resort: into the reserve itself, still oldest first, never the current turn.
  for (let i = tailStart; i < lastIdx && estimated >= budgetTokens; i++) drop(i);

  if (turnsDropped === 0) return null;

  const build = () => {
    const list = [...prefix, ...turns.filter((_, i) => keep[i]).flat()];
    const trimmed = { ...body, [key]: list };
    return { list, trimmed, estimatedPrompt: estimateBodyTokens(trimmed) };
  };

  let { list, trimmed, estimatedPrompt } = build();
  // The per-turn costs are an approximation of the body's own serialization, so
  // the plan can land just short. One corrective pass, dropping everything that
  // is droppable, settles it — the caller rejects if even that still overflows.
  if (estimatedPrompt >= budgetTokens && turnsDropped < lastIdx) {
    for (let i = 0; i < lastIdx; i++) {
      if (keep[i]) drop(i);
    }
    ({ list, trimmed, estimatedPrompt } = build());
  }

  return { key, list, body: trimmed, turnsDropped, estimatedPrompt };
}

/**
 * Enforce the model's context window on a translated request body (mutates
 * `body` in place when clamping or trimming — callers build one body per
 * dispatch attempt, so the mutation never leaks into a fallback attempt).
 *
 * @param {object} body - translated request body (already in the upstream format)
 * @param {number} contextWindow - model's total context window in tokens
 * @returns {{ action: "ok"|"clamped"|"trimmed"|"reject", estimatedPrompt: number,
 *             contextWindow: number, requestedOutput?: number,
 *             clampedTo?: number, turnsDropped: number, message?: string }}
 */
export function enforceContextWindow(body, contextWindow) {
  if (!body || typeof body !== "object" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { action: "ok", estimatedPrompt: 0, contextWindow, turnsDropped: 0 };
  }

  let estimatedPrompt = estimateBodyTokens(body);
  const requested = readOutputCeiling(body);
  const requestedOutput = requested?.value || 0;
  let turnsDropped = 0;
  const effectiveWindow = Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN);

  // Prompt alone already exceeds the margined window: shed middle turns first
  // (see planHistoryTrim) — the common case when the client's own idea of the
  // model's window (e.g. Claude Code assuming 1M) doesn't match the real,
  // smaller one and it never auto-compacted.
  if (estimatedPrompt >= effectiveWindow) {
    const trim = planHistoryTrim(body, effectiveWindow);
    if (trim) {
      body[trim.key] = trim.list;
      turnsDropped = trim.turnsDropped;
      estimatedPrompt = trim.estimatedPrompt;
    }

    // Still over — either nothing was droppable (a single turn already) or even
    // the current turn alone overflows. Nothing left to salvage, so reject up
    // front. The wording deliberately carries "maximum context length" so the
    // ERROR_RULES noFallback rule classifies this locally-detected overflow the
    // same way it classifies the upstream one — otherwise this reject would be
    // read as a transient 400 and lock the account.
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
