export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
    const { installDevelopmentLogSanitizer } = await import("./build/sanitize-development-log.ts");
    installDevelopmentLogSanitizer();
  }
}
