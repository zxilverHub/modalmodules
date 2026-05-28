#!/usr/bin/env node
import { startServer } from '../src/server/HttpServer.js';

const args = process.argv.slice(2);
const cmd = args[0];

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else { out[key] = 'true'; }
  }
  return out;
}

function usage() {
  console.error('Usage: modalmodules serve [--port 8787] [--host 127.0.0.1] [--quiet] [--verbose] [--preferences <path>]');
  console.error('Env:   MODALMODULES_API_KEY        require Bearer token on /v1/* routes');
  console.error('       MODALMODULES_QUIET=1        suppress per-request summary lines');
  console.error('       MODALMODULES_VERBOSE=1      print per-action library logs (removals, cleanup, accepts)');
  console.error('       MODALMODULES_PREFERENCES    path to user-preferences.json (default: bundled spec/)');
}

if (cmd === 'serve') {
  const flags = parseFlags(args.slice(1));
  const port = Number(flags.port || process.env.PORT || 8787);
  const host = flags.host || process.env.HOST || '127.0.0.1';
  const quiet = flags.quiet === 'true' || process.env.MODALMODULES_QUIET === '1';
  const verbose = flags.verbose === 'true' || process.env.MODALMODULES_VERBOSE === '1';
  const preferencesPath = flags.preferences && flags.preferences !== 'true'
    ? flags.preferences
    : process.env.MODALMODULES_PREFERENCES || undefined;
  startServer({ port, host, quiet, verbose, preferencesPath }).then(({ url, preferences }) => {
    console.log(`modalmodules listening on ${url}`);
    console.log(`  POST ${url}/v1/clean             HTML body → cleaned HTML`);
    console.log(`  POST ${url}/v1/clean-url         {"url": "..."} → cleaned HTML (server-side fetch)`);
    console.log(`  POST ${url}/v1/auto-accept-url   {"url": "..."} → cleaned HTML (Playwright render + accept click, optional peer dep)`);
    console.log(`  GET  ${url}/health`);
    if (process.env.MODALMODULES_API_KEY) {
      console.log('  auth: Bearer token required (MODALMODULES_API_KEY is set)');
    }
    const mode = quiet ? 'quiet' : (verbose ? 'verbose' : 'summary');
    const note = mode === 'quiet'
      ? '(no per-request lines)'
      : mode === 'verbose'
        ? '(per-action details + request summary)'
        : '(request summary only — use --verbose for per-action details)';
    console.log(`  logs: ${mode} ${note}`);
    if (preferences) {
      console.log(`  preferences: popups=${preferences.popups}, cookies=${preferences.cookies}, authModals=${preferences.authModals}`);
      console.log(`               (override per-request via ?popups=ignore, ?cookies=decline, ?authModals=ignore)`);
    }
  });
} else {
  usage();
  process.exit(1);
}
