const SENSITIVE_ROUTE_QUERY =
  /(\/api\/(?:mail\/search|mail\/messages\/[^/?\s]+|mail\/threads\/[^/?\s]+|oauth\/(?:google|microsoft)\/callback))\?[^\s]*/g;

/** Prevent transient search and OAuth parameters from entering development logs. */
export function sanitizeDevelopmentLog(message: string): string {
  return message.replace(SENSITIVE_ROUTE_QUERY, "$1?[REDACTED]");
}

let installed = false;

/**
 * Vinext writes request lines directly to process streams instead of Vite's
 * logger, so protect the streams before the development plugins start.
 */
export function installDevelopmentLogSanitizer(): void {
  if (installed) return;
  installed = true;

  for (const stream of [process.stdout, process.stderr]) {
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const sanitized = typeof chunk === "string"
        ? sanitizeDevelopmentLog(chunk)
        : chunk;
      return Reflect.apply(originalWrite, stream, [sanitized, ...args]);
    }) as typeof stream.write;
  }
}
