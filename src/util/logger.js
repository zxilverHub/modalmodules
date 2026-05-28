// Logger factory. Three call shapes:
//   createLogger(false | undefined) → noop
//   createLogger(true)              → console (info to stdout, error to stderr)
//   createLogger(fn)                → fn({level, message, details, ts}) per event
//   createLogger({output, prefix})  → custom output function + prefix
//
// Events are { level: 'info'|'debug'|'error', message: string, details?: any, ts: number }.
// Callers (services, API, HTTP server) emit semantic events; the logger decides
// how to render them. Library calls are silent by default — opt in per call.

function noop() {}
const NOOP = Object.freeze({ info: noop, debug: noop, error: noop });

function defaultOutput(event) {
  const prefix = event._prefix || '[modalmodules]';
  const line = `${prefix} ${event.message}`;
  if (event.level === 'error') console.error(line);
  else console.log(line);
}

export function createLogger(opts) {
  if (!opts) return NOOP;

  if (typeof opts === 'function') {
    const fn = opts;
    const emit = (level, message, details) =>
      fn({ level, message, details, ts: Date.now() });
    return {
      info: (m, d) => emit('info', m, d),
      debug: (m, d) => emit('debug', m, d),
      error: (m, d) => emit('error', m, d),
    };
  }

  const config = opts === true ? {} : opts;
  const output = config.output || defaultOutput;
  const prefix = config.prefix || '[modalmodules]';
  const emit = (level, message, details) =>
    output({ level, message, details, ts: Date.now(), _prefix: prefix });
  return {
    info: (m, d) => emit('info', m, d),
    debug: (m, d) => emit('debug', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

export { NOOP as NOOP_LOGGER };
