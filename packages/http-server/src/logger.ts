/**
 * Structured log context attached to every log call.
 * Implementations can use this for JSON logging, tracing, metrics, etc.
 */
export interface LogContext {
  readonly [key: string]: unknown;
}

/**
 * Logger interface shared by TypeSpex server and adapter packages.
 * Implement this interface to plug in any logging backend (pino, winston, OpenTelemetry, etc).
 */
export interface Logger {
  error(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
}

/** Default logger that writes structured context to console. */
export const consoleLogger: Logger = {
  error(message, ctx) {
    if (ctx) console.error(message, ctx);
    else console.error(message);
  },
  warn(message, ctx) {
    if (ctx) console.warn(message, ctx);
    else console.warn(message);
  },
  info(message, ctx) {
    if (ctx) console.info(message, ctx);
    else console.info(message);
  },
};
