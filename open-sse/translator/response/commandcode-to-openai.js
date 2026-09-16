/**
 * CommandCode → OpenAI response translator
 *
 * CommandCode upstream emits NDJSON-style AI SDK v5 stream events:
 *   {"type":"start"} {"type":"start-step", ...}
 *   {"type":"reasoning-start","id":"..."} {"type":"reasoning-delta","text":"..."}
 *   {"type":"text-start","id":"..."}     {"type":"text-delta","text":"..."}
 *   {"type":"tool-input-start","id","toolName"}
 *   {"type":"tool-input-delta","id","delta"}
 *   {"type":"tool-input-end","id"}
 *   {"type":"tool-call","toolCallId","toolName","input"}
 *   {"type":"finish-step","finishReason","usage": {...}, ...}
 *   {"type":"finish",...}
 *
 * Each upstream "event" arrives as one JSON object per line — we receive it as a string chunk
 * already split per line by the upstream SSE/JSON-line reader in 9router.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

function ensureState(state, model) {
  if (!state.responseId) {
    state.responseId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.model = state.model || model || "commandcode";
    state.chunkIndex = 0;
    state.toolIndex = 0;
    state.toolIndexById = new Map();
    state.openTools = new Set();
    state.openText = false;
    state.finishReason = null;
    state.usage = null;
  }
}

function makeChunk(state, delta, finishReason = null) {
  return buildChunk(
    { id: state.responseId, created: state.created, model: state.model },
    delta,
    finishReason
  );
}

const mapFinishReason = (reason) => toOpenAIFinish(reason, "commandcode");

export function commandCodeToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  // A failure is terminal: everything the upstream emits afterwards is
  // post-mortem noise. Without this latch a trailing `finish` event would emit
  // a clean finish chunk, and openai-to-claude.js would then close the turn
  // with message_stop — the exact "looks successful" signal this changed
  // behaviour exists to prevent.
  if (state.errored) return null;

  // Already-OpenAI chunk: pass through
  if (chunk && typeof chunk === "object" && chunk.object === "chat.completion.chunk") {
    return chunk;
  }

  // Error chunk (emitted by this translator, or already shaped this way by an
  // executor). It carries no `.type`, so the guard at the bottom would drop it —
  // pass it through untouched for openai-to-claude.js to turn into an error event.
  if (chunk && typeof chunk === "object" && chunk.error) {
    return chunk;
  }

  // Parse string lines coming out of upstream
  let event = chunk;
  if (typeof chunk === "string") {
    const line = chunk.trim();
    if (!line) return null;
    // Tolerate raw "data: {...}" framing if the upstream wrapper inserts it
    const json = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!json || json === "[DONE]") return null;
    try {
      event = JSON.parse(json);
    } catch {
      return null;
    }
  }

  if (!event || typeof event !== "object" || !event.type) return null;

  ensureState(state, event.model);
  const out = [];

  switch (event.type) {
    case "text-delta": {
      const text = event.text || event.delta || "";
      if (!text) break;
      const delta = state.chunkIndex === 0 ? { role: ROLE.ASSISTANT, content: text } : { content: text };
      state.chunkIndex++;
      state.openText = true;
      out.push(makeChunk(state, delta));
      break;
    }
    case "reasoning-delta": {
      const text = event.text || "";
      if (!text) break;
      // Map reasoning to OpenAI "reasoning_content" field (used by deepseek-reasoner-style clients).
      const delta = reasoningDelta(text, state.chunkIndex === 0);
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-input-start": {
      const id = event.id || event.toolCallId || fallbackToolCallId(state.toolIndex);
      let idx = state.toolIndexById.get(id);
      if (idx == null) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      state.openTools.add(id);
      const delta = {
        ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
        tool_calls: [{
          index: idx,
          id,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: event.toolName || "", arguments: "" },
        }],
      };
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-input-delta": {
      const id = event.id || event.toolCallId;
      const idx = state.toolIndexById.get(id);
      if (idx == null) break;
      const delta = {
        tool_calls: [{
          index: idx,
          function: { arguments: event.delta || event.inputTextDelta || "" },
        }],
      };
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-call": {
      // Final consolidated tool call — only emit if we never saw tool-input-* deltas.
      const id = event.toolCallId;
      if (state.toolIndexById.has(id)) break;
      const idx = state.toolIndex++;
      state.toolIndexById.set(id, idx);
      const argsStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
      const delta = {
        ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
        tool_calls: [{
          index: idx,
          id,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: event.toolName || "", arguments: argsStr },
        }],
      };
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "finish-step": {
      state.finishReason = mapFinishReason(event.finishReason);
      if (event.usage) state.usage = event.usage;
      break;
    }
    case "finish": {
      const finishReason = state.finishReason || mapFinishReason(event.finishReason || "stop");
      const finalChunk = makeChunk(state, {}, finishReason);
      const totalUsage = event.totalUsage || state.usage;
      const usage = toOpenAIUsage(totalUsage, "commandcode");
      if (usage) finalChunk.usage = usage;
      out.push(finalChunk);
      break;
    }
    case "error": {
      // The upstream failed after the response had already started streaming.
      // Appending the message to the assistant text and closing with a clean
      // `stop` (the previous behaviour) makes clients read the failure as the
      // model's final answer: the turn ends there and nothing is retried. Emit
      // an error chunk instead — openai-to-claude.js turns it into a
      // protocol-legal Anthropic `error` event, and the stream terminates
      // without a message_stop so the client can tell the turn was incomplete.
      const errVal = event.error ?? event.message ?? "unknown";
      const errMessage = typeof errVal === "string"
        ? errVal
        : (errVal?.message || JSON.stringify(errVal));
      const errType = (errVal && typeof errVal === "object" && errVal.type) || "server_error";
      state.errored = true;
      out.push({ error: { message: `[CommandCode error: ${errMessage}]`, type: errType } });
      break;
    }
    // Silently ignore: start, start-step, reasoning-start, reasoning-end, text-start, text-end,
    // provider-metadata, message-metadata, etc. They carry no client-visible content.
    default:
      break;
  }

  return out.length ? out : null;
}

register(FORMATS.COMMANDCODE, FORMATS.OPENAI, null, commandCodeToOpenAIResponse);
