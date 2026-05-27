// Launcher that:
//   1. Strips ELECTRON_RUN_AS_NODE from the env (some host shells set it, which
//      forces Electron into Node-only mode and breaks the main process).
//   2. Filters known-harmless Chromium / Electron log noise out of stderr so
//      the dev terminal stays readable.
import { spawn } from 'node:child_process';

const [, , ...args] = process.argv;
if (args.length === 0) {
  console.error('usage: run.mjs <command> [...args]');
  process.exit(2);
}

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

// Patterns of log lines we know are harmless and that pollute the dev terminal.
// Keep this list tight — when in doubt, leave the line visible.
const NOISE_PATTERNS = [
  /wgc_capture_session\.cc.*ProcessFrame failed.*using existing frame/, // WGC frame dedup, no effect on capture
  /cache_util_win\.cc.*Unable to move the cache/,                        // multi-instance dev cache contention
  /disk_cache\.cc.*Unable to create cache/,                              // same root cause as above
  /gpu_disk_cache\.cc.*Gpu Cache Creation failed/,                       // same root cause
  /Unknown VE context: language-mismatch/,                               // DevTools internal noise
  /Request Autofill\.(enable|setAddresses) failed/,                      // DevTools probing missing API
  /\[DEP0190\] DeprecationWarning/,                                      // Node deprecation about shell:true args
];

function shouldDrop(line) {
  return NOISE_PATTERNS.some((p) => p.test(line));
}

function filterStream(stream, sink) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      if (!shouldDrop(line)) sink.write(line);
    }
  });
  stream.on('end', () => {
    if (buf && !shouldDrop(buf)) sink.write(buf);
  });
}

const [cmd, ...rest] = args;
const child = spawn(cmd, rest, {
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true,
  env,
});

filterStream(child.stdout, process.stdout);
filterStream(child.stderr, process.stderr);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
