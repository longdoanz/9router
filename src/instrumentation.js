export async function register() {
  // Run only in the Node.js runtime (not Edge), and not during build
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initializeApp } = await import("./shared/services/initializeApp.js");
  initializeApp().catch((e) => console.error("[Instrumentation] init failed:", e.message));
}
