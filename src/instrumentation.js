export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    const { initializeApp } = await import("./shared/services/initializeApp.js");
    initializeApp().catch((e) => console.error("[Instrumentation] init failed:", e.message));

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Forwards ERROR-level console output to Telegram. No-op unless
    // TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
    const { telegramNotifier } = await import("@/lib/telegramNotifier.js");
    telegramNotifier.start();
  }
}
