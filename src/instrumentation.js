export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    const { initializeApp } = await import("./shared/services/initializeApp.js");
    initializeApp().catch((e) => console.error("[Instrumentation] init failed:", e.message));
  }
}
