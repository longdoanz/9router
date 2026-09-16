import https from "node:https";
import { getConsoleEmitter, initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { TELEGRAM_CONFIG } from "@/shared/constants/config.js";

/**
 * Forwards ERROR-level console lines to Telegram.
 *
 * Reads a filtered copy of the console stream in-process (no extra console
 * patching, no per-line work on the hot path) and delivers through a bounded
 * queue drained by background timers.
 *
 * Anti-spam mirrors the Python notifier in the gateway repo so both share one
 * channel without one drowning out the other:
 *   - the same line is sent at most once per DEDUP_WINDOW_MS
 *   - at most MAX_SENDS_PER_WINDOW messages per RATE_WINDOW_MS
 *
 * Disabled unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are both set.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Telegram caps a message at 4096 chars; leave headroom for the HTML wrapper.
const MSG_MAX_CHARS = 3500;

// The gateway's Python notifier tags its messages with this so the shared
// channel tells at a glance which service is shouting.
const SOURCE_LABEL = "9router";

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatLine(line) {
  return String(line).replace(ANSI_RE, "").trim();
}

// The logger writes its own timestamp as "[HH:MM:SS] "; drop it so the message
// does not carry a time that disagrees with the one Telegram shows.
function stripLeadingTime(line) {
  return line.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "");
}

/**
 * Decide whether a captured console record is worth alerting on.
 *
 * Level is the primary signal: a genuine console.error() must be forwarded even
 * though it carries no marker, and request chatter that merely mentions an
 * error must not be. The marker is only a fallback, because the app's own
 * logger.error() (src/sse/utils/logger.js) writes "❌" through console.log and
 * would otherwise be missed entirely.
 */
function looksLikeError(level, line) {
  if (level === "error") return true;
  // console.assert(false, ...) lands on "assert" and is always a failure.
  if (level === "assert") return true;
  return TELEGRAM_CONFIG.errorPattern.test(line);
}

class TelegramNotifier {
  constructor() {
    this._queue = [];
    this._seen = new Map();
    this._sendTimes = [];
    this._sending = false;
    this._flushTimer = null;
    this._pruneTimer = null;
    this._onRecords = null;
    this._started = false;
  }

  isEnabled() {
    return Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID &&
      process.env.NEXT_RUNTIME === "nodejs"
    );
  }

  start() {
    if (this._started || !this.isEnabled()) return;
    this._started = true;

    initConsoleLogCapture();

    // "records" is the level-aware feed: it is the only channel that can tell a
    // genuine console.error() from a console.log() line that merely quotes an
    // error (request chatter does this constantly).
    this._onRecords = (records) => {
      const list = Array.isArray(records) ? records : [records];
      for (const rec of list) {
        if (!rec || typeof rec.line !== "string") continue;
        if (!looksLikeError(rec.level, rec.line)) continue;
        this._enqueue(rec.line);
      }
    };

    const emitter = getConsoleEmitter();
    emitter.on("records", this._onRecords);

    this._flushTimer = setInterval(() => this._flush(), TELEGRAM_CONFIG.FLUSH_INTERVAL_MS);
    this._flushTimer?.unref?.();

    // Bound _seen: without this a long-lived process accumulates one entry per
    // distinct line ever seen.
    this._pruneTimer = setInterval(() => this._prune(), TELEGRAM_CONFIG.DEDUP_WINDOW_MS);
    this._pruneTimer?.unref?.();
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._flushTimer = null;
    this._pruneTimer = null;
    if (this._onRecords) {
      getConsoleEmitter().off("records", this._onRecords);
    }
    this._onRecords = null;
  }

  /**
   * Queue an already-selected line. Synchronous and non-throwing: it runs on
   * whatever thread emitted the log line, including the request path.
   *
   * Selection happens in _onRecords, which is the only production caller — the
   * level is not available here, so a filter at this point could only ever use
   * the weaker marker test and would drop genuine markerless console.error()
   * records that were correctly selected upstream.
   */
  _enqueue(line) {
    try {
      if (typeof line !== "string" || !line) return;
      const text = formatLine(line);
      if (!text) return;
      // A full queue only drops *new* entries — never evicts older ones, so the
      // first sign of trouble is the one that survives.
      if (this._queue.length >= TELEGRAM_CONFIG.QUEUE_MAX) return;
      this._queue.push(text);
    } catch {
      /* never let notification bookkeeping break a request */
    }
  }

  _flush() {
    if (this._sending || this._queue.length === 0) return;
    const text = this._queue.shift();
    const sig = text;

    const now = Date.now();
    const last = this._seen.get(sig);
    if (last != null && now - last < TELEGRAM_CONFIG.DEDUP_WINDOW_MS) return;
    this._seen.set(sig, now);

    this._sendTimes = this._sendTimes.filter((t) => now - t < TELEGRAM_CONFIG.RATE_WINDOW_MS);
    if (this._sendTimes.length >= TELEGRAM_CONFIG.MAX_SENDS_PER_WINDOW) return;
    this._sendTimes.push(now);

    this._sending = true;
    this._post(this._formatMessage(text))
      .catch(() => { /* delivery failure must never surface as an error loop */ })
      .finally(() => { this._sending = false; });
  }

  _prune() {
    const cutoff = Date.now() - TELEGRAM_CONFIG.DEDUP_WINDOW_MS;
    for (const [sig, at] of this._seen) {
      if (at < cutoff) this._seen.delete(sig);
    }
  }

  _formatMessage(text) {
    const body = stripLeadingTime(text);
    let out = `❌ <b>${SOURCE_LABEL}</b>\n<code>${escapeHtml(body)}</code>`;
    if (out.length > MSG_MAX_CHARS) out = out.slice(0, MSG_MAX_CHARS) + "…";
    return out;
  }

  async _post(text, attempt = 0) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const status = await this._request(url, body);

    // One bounded retry on a transient 5xx.
    if (status != null && status >= 500 && attempt < 1) {
      return this._post(text, attempt + 1);
    }
  }

  /**
   * Raw HTTPS POST. Deliberately not global fetch: open-sse/utils/proxyFetch.js
   * replaces globalThis.fetch to route provider traffic through a configured
   * outbound proxy, and notification delivery must not be dragged along that
   * path (Telegram is reachable directly, and a misconfigured proxy would
   * silently swallow every alert).
   */
  _request(url, body) {
    return new Promise((resolve) => {
      const req = https.request(
        url,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 10000 },
        (res) => {
          res.resume(); // drain so the socket can be reused/closed
          resolve(res.statusCode ?? null);
        }
      );
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end(body);
    });
  }
}

export const telegramNotifier = new TelegramNotifier();
