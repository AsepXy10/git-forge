// Entry lifecycle: bind one ephemeral port, register it with the env,
// then poll until the env says the trial is finished and exit 0.
// This file is the harness lifecycle, not the forge itself: the forge
// lives in app.ts, and the suite scores that server.
//
// Flow, in order:
//   - MAKEFUN_ENV_URL must be set (http://store:8080 inside a trial).
//     Without it there is nothing to talk to, so exit 1 right away.
//   - Start the server on port 0 and let the kernel pick a free port.
//     Never bind 8080, which belongs to the env.
//   - POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records
//     the caller's address plus N as the base URL. The first register
//     wins; a 409 means someone already registered first.
//   - GET $MAKEFUN_ENV_URL/done in a poll loop until {"done": true}.
//     The env answers immediately, so poll with backoff, never hold
//     a request open, and never exit before it says done.
//   - Close the server and exit 0. The env then writes the export
//     the scorer reads.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing, nothing to register with\n');
  process.exit(1);
}

const requestTimeout = 30_000;
const backoffStart = 250;
const backoffCap = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(failures: number): number {
  const doubled = backoffStart * 2 ** Math.min(failures, 8);
  return doubled > backoffCap ? backoffCap : doubled;
}

async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        body: JSON.stringify({ port }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register failed with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register failed with HTTP ')) throw err;
    }
    await wait(nextDelay(failures));
    failures += 1;
  }
}

async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Env not answering yet, or the poll timed out: keep polling.
    }
    await wait(nextDelay(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered, waiting for done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
