# github-core-clone-01 — git forge entry

A complete GitHub-compatible git forge for [the contest](https://make.fun/bounty/github-core-clone-01),
built on the starter: a single-process Node 22 TypeScript server, stdlib only, no dependencies, no
`git` binary, no outside service, no UI. All state lives in memory; server-created commits use fixed
timestamps and counters, so two runs on the same instance leave the same state export byte-for-byte.

## What is implemented (in `app.ts`)

- **Git smart HTTP** at `/{owner}/{repo}.git`: `info/refs` (v0 and v2 advertisements), `git-upload-pack`
  protocol v2 (`ls-refs` with symrefs/peel/ref-prefix, `fetch` with thin-pack, `have` negotiation,
  `deepen`/`deepen-since`/`deepen-not`, shallow-info with `shallow`/`unshallow`), v0 fetch, and
  `git-receive-pack` v0 (pack parsing with OFS/REF deltas, per-ref fast-forward rules, mixed
  ok/ng report-status, deletes). Packfiles are written plain (no deltas) and verified by SHA-1.
- **REST v3** under `/api/v3`: repos (CRUD, pagination with `Link: rel="next"`), branches, commits,
  git refs, contents (create/update/delete with stale-sha 409), labels, issues (state/sort/pagination),
  comments, pull requests (files, squash merge with conflict detection → 405). Every reply is
  `application/json` with a non-empty `X-GitHub-Request-Id`; errors are JSON with a string `message`.
- **GraphQL v4** at `POST /api/graphql`: `viewer`, `repository` (with `issues`/`pullRequests`
  connections, cursor pagination, `issue`/`pullRequest` by number), `node(id:)` Relay round-trip with
  opaque base64 global ids, `__type` introspection, mutations `createIssue`/`closeIssue`/
  `createPullRequest`/`mergePullRequest`/`addComment`, batched operation arrays, and field errors as
  HTTP 200 with an `errors` array.
- **MCP** at `POST /mcp`: modern `server/discover` (protocol `2026-07-28`, legacy `initialize`
  fallback), `tools/list` (six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`), `tools/call` with JSON-RPC errors, parse-error
  HTTP 400 / -32700, and 401 without a token. All four surfaces share one store.

## Local grading

```sh
# from the kit folder, process driver (no Docker on this VM):
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/git-forge-entry --driver process --instances 1
# or the SDK conformance runner against a running server:
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token --perf
```

Latest local results (2026-11-19): SDK runner **120/120 checks, 926/1000** (feature 600, agent 200,
perf 126); sealed `grade-local` run pending in the report.

## Run it

```sh
node --experimental-strip-types main.ts
```

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server. This is the file to grow.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
