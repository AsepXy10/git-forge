// GitHub-compatible git forge: one process, stdlib only.
// Serves git smart HTTP (v2 upload-pack / v0 receive-pack), REST v3, GraphQL v4 and MCP
// from a single in-memory store. Deterministic: fixed timestamps, counters only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const VIEWER = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const FIXED_ISO = '2025-01-01T00:00:00Z';
const BASE_EPOCH = 1735689600;
const JSON_TYPE = 'application/json; charset=utf-8';

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: GitObjectType; data: Buffer }
interface TreeEntry { mode: string; name: string; oid: string }
interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; seq: number; comments: { id: number; body: string; seq: number }[];
}
interface Pull {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  head: string; base: string; headSha: string; baseSha: string; seq: number;
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
}
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string; seq: number;
  refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Issue[]; nextIssue: number; labels: Map<string, { name: string; color: string }>;
  pulls: Pull[]; nextPull: number;
}
// Cache of serialized packs for identical fetch requests; the key embeds the
// repo's object count and ref tips, so any mutation invalidates it.
const packCache = new Map<string, Buffer>();
function packCacheKey(repo: Repo, wants: string[], haves: string[], depth: number | null, deepenSince: number | null, deepenNot: string[], shallow: string[]): string {
  return `${repo.id}|${repo.objects.size}|${[...repo.refs.entries()].map(([k, v]) => `${k}=${v}`).join(',')}|${wants.join(',')}|${haves.join(',')}|${depth}|${deepenSince}|${deepenNot.join(',')}|${shallow.join(',')}`;
}
function cachedPack(repo: Repo, objects: GitObject[], key: string): Buffer {
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(objects);
  packCache.set(key, pack);
  if (packCache.size > 64) { const first = packCache.keys().next().value; if (first !== undefined) packCache.delete(first); }
  return pack;
}

const repos = new Map<string, Repo>();
let repoIdCounter = 5000;
let commentIdCounter = 1;
let commitSeq = 0;
let reqCounter = 0;

const gid = (kind: string, ...parts: (string | number)[]): string =>
  Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
const repoGid = (r: Repo): string => gid('Repository', r.id);
const issueGid = (r: Repo, i: Issue): string => gid('Issue', r.id, i.number);
const pullGid = (r: Repo, p: Pull): string => gid('PullRequest', r.id, p.number);

// ---------------------------------------------------------------- git objects
function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name), Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name)));
  const parts: Buffer[] = [];
  for (const e of sorted) { parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8')); parts.push(Buffer.from(e.oid, 'hex')); }
  return Buffer.concat(parts);
}
function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) { const sp = line.indexOf(' '); if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1)); }
  return { object: m.get('object') ?? '', type: m.get('type') ?? '', tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}
function buildCommit(tree: string, parents: string[], message: string, timestamp: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : message + '\n'}`, 'utf8');
}
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>(); const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree, ...c.parents); }
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}
// tree -> flat path map (path -> {oid, mode})
function fileMap(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
      else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}
function treeFromMap(repo: Repo, map: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) { if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make()); node = node.dirs.get(segs[i])!; }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function refTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}
function commitForBranch(repo: Repo, branch: string, files: Map<string, Buffer>, message: string): string {
  const tip = refTip(repo, branch);
  const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  const map = fileMap(repo, baseTree);
  for (const [path, content] of files) map.set(path, { oid: putObject(repo, 'blob', content), mode: '100644' });
  const tree = treeFromMap(repo, map);
  const ts = BASE_EPOCH + commitSeq++;
  const commit = putObject(repo, 'commit', buildCommit(tree, tip ? [tip] : [], message, ts));
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}
function deleteFromBranch(repo: Repo, branch: string, path: string, message: string): string | null {
  const tip = refTip(repo, branch); if (!tip) return null;
  const map = fileMap(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  if (!map.has(path)) return null;
  map.delete(path);
  const tree = treeFromMap(repo, map);
  const ts = BASE_EPOCH + commitSeq++;
  const commit = putObject(repo, 'commit', buildCommit(tree, [tip], message, ts));
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}
function ancestors(repo: Repo, tip: string | null): string[] {
  const out: string[] = []; const seen = new Set<string>(); const queue = tip ? [tip] : []; let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi++];
    if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>(); const queue = [tip]; let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi++];
    if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}
function mergeBase(repo: Repo, a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const ancB = new Set(ancestors(repo, b));
  for (const oid of ancestors(repo, a)) if (ancB.has(oid)) return oid;
  return null;
}
// ---------------------------------------------------------------- packfiles
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => { let v = 0; let sh = 0; for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) { co += delta[off++] * 2 ** sh; } sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) { cs += delta[off++] * 2 ** sh; } sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs); written += cs;
    } else if (op !== 0) { const n = op & 0x7f; delta.copy(out, written, off, off + n); off += n; written += n; }
    else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) throw new Error('bad pack checksum');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]; let size = byte & 0x0f; let shift = 4; offset += 1;
    while (byte & 0x80) { byte = pack[offset++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    const typeCode = (pack[entryOffset] >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset]; offset += 1; let v = b & 0x7f;
      while (b & 0x80) { b = pack[offset++]; v = ((v + 1) * 128) + (b & 0x7f); }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) { entry.baseOid = pack.subarray(offset, offset + 20).toString('hex'); offset += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const inf = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inf.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inf.data; offset = inf.next;
    raw.push(entry); byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>(); const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if ((entry as unknown as { _oid?: string })._oid) {
      const r = entry as unknown as { _oid: string; _type: GitObjectType; _data: Buffer };
      return { type: r._type, data: r._data, oid: r._oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType; let data: Buffer;
    if (entry.typeCode === 6) { const base = resolve(byOffset.get(entry.baseOffset!)!); type = base.type; data = applyDelta(base.data, entry.data); }
    else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) { const base = resolve(baseEntry); type = base.type; data = applyDelta(base.data, entry.data); }
      else { const ext = lookup(entry.baseOid!); if (!ext) throw new Error('ref-delta base missing'); type = ext.type; data = applyDelta(ext.data, entry.data); }
    } else { type = CODE_TYPE[entry.typeCode]; data = entry.data; }
    const oid = hashObject(type, data);
    (entry as unknown as { _oid: string; _type: GitObjectType; _data: Buffer })._oid = oid;
    (entry as unknown as { _type: GitObjectType })._type = type;
    (entry as unknown as { _data: Buffer })._data = data;
    resolvedByOid.set(oid, entry); resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) { const r = resolve(entry); if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data }); }
  return objects;
}
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type]; const bytes: number[] = [];
  let remaining = size; let first = (code << 4) | (remaining & 0x0f); remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first); return Buffer.from(bytes);
}
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) { parts.push(writePackObjectHeader(o.type, o.data.length)); parts.push(deflateSync(o.data)); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
// pkt-lines
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(4); h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function decodePktLines(buf: Buffer): { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }[] {
  const out: { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line');
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function addTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else out.add(e.oid);
    }
  }
}
function collectReachableBounded(repo: Repo, roots: Iterable<string>, stopAt: Set<string>): Set<string> {
  // Reachable objects, but never descend into the parents of a commit in stopAt:
  // the client's shallow boundaries mean "I have this commit, not its history".
  const seen = new Set<string>(); const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      addTreeObjects(repo, c.tree, seen);
      if (!stopAt.has(oid)) queue.push(...c.parents);
    } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') addTreeObjects(repo, oid, seen);
  }
  return seen;
}
interface FetchSelection { send: Set<string>; shallow: Set<string>; unshallow: Set<string> }
function selectFetch(repo: Repo, wantedTips: string[], haves: string[], opts: { depth?: number | null; deepenSince?: number | null; deepenNot?: string[]; shallowBoundaries?: string[] }): FetchSelection {
  const haveSet = collectReachableBounded(repo, haves, new Set(opts.shallowBoundaries ?? []));
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  const excludedCommits = new Set<string>();
  if (opts.deepenNot?.length) {
    for (const oid of collectReachable(repo, opts.deepenNot.filter((o) => repo.objects.has(o)))) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') excludedCommits.add(oid);
    }
  }
  const queue: { oid: string; d: number }[] = [];
  for (const w of wantedTips) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') { included.add(w); const t = parseTag(obj.data); if (repo.objects.has(t.object)) queue.push({ oid: t.object, d: 0 }); }
    else if (obj.type === 'commit') queue.push({ oid: w, d: 0 });
    else included.add(w);
  }
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (includedCommits.has(oid) || excludedCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    const c = parseCommit(obj.data);
    included.add(oid);
    addTreeObjects(repo, c.tree, included);
    if (opts.depth != null && d >= opts.depth - 1) continue;
    for (const p of c.parents) {
      if (excludedCommits.has(p)) continue;
      if (opts.deepenSince != null) {
        const pObj = repo.objects.get(p);
        if (pObj?.type === 'commit') {
          const ts = parseInt((parseCommit(pObj.data).author.match(/ (\d+) \+0000$/)?.[1]) ?? '0', 10);
          if (ts < opts.deepenSince) continue;
        }
      }
      queue.push({ oid: p, d: d + 1 });
    }
  }
  // Shallow boundary: an included commit with a parent that is not included.
  const shallow = new Set<string>();
  for (const oid of includedCommits) {
    const obj = repo.objects.get(oid)!;
    const c = parseCommit(obj.data);
    if (c.parents.length && c.parents.some((p) => !includedCommits.has(p))) shallow.add(oid);
  }
  // Unshallow: a boundary the client already had that is now fully included.
  const unshallow = new Set<string>();
  for (const b of opts.shallowBoundaries ?? []) {
    if (includedCommits.has(b) && !shallow.has(b)) unshallow.add(b);
  }
  const send = new Set([...included].filter((o) => !haveSet.has(o)));
  return { send, shallow, unshallow };
}
function sideband(pack: Buffer, chunkSize = 60000): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += chunkSize) {
    const slice = pack.subarray(i, i + chunkSize);
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------- HTTP plumbing
function reqId(): string { reqCounter += 1; return `req-${reqCounter}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId(), ...extra });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}
function notFound(res: ServerResponse, msg = 'Not Found'): void { sendJson(res, 404, { message: msg }); }
function badRequest(res: ServerResponse, msg = 'Bad Request'): void { sendJson(res, 400, { message: msg }); }
function unauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Requires authentication' }); }
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
function authed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
const VIEWER_USER_OBJ: Record<string, unknown> = { login: VIEWER, id: VIEWER_ID, node_id: gid('User', VIEWER_ID), avatar_url: '', gravatar_id: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL, html_url: `https://github.com/${VIEWER}`, url: `/api/v3/users/${VIEWER}` };
function viewerUser(): Record<string, unknown> {
  return VIEWER_USER_OBJ;
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: repoGid(r), name: r.name, full_name: `${r.owner}/${r.name}`, private: r.priv,
    owner: viewerUser(), html_url: `https://github.com/${r.owner}/${r.name}`, description: r.description, fork: false,
    url: `/api/v3/repos/${r.owner}/${r.name}`, created_at: FIXED_ISO, updated_at: FIXED_ISO, pushed_at: FIXED_ISO,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null, has_issues: true,
    has_projects: true, has_downloads: true, has_wiki: true, has_pages: false, has_discussions: false,
    forks_count: 0, archived: false, disabled: false, open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [], visibility: r.priv ? 'private' : 'public',
    default_branch: r.defaultBranch, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: issueGid(r, i), number: i.number, title: i.title, body: i.body, state: i.state,
    locked: false, user: viewerUser(), labels: i.labels.map((l) => ({ id: 1, node_id: gid('Label', r.id, l.name), name: l.name, color: l.color, description: '' })),
    assignee: null, assignees: [], milestone: null, comments: i.comments.length, created_at: FIXED_ISO, updated_at: FIXED_ISO,
    closed_at: i.state === 'closed' ? FIXED_ISO : null, author_association: 'OWNER', html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`, repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function pullFilesOf(repo: Repo, p: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] { return p.files; }
function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id, node_id: pullGid(r, p), number: p.number, title: p.title, body: p.body, state: p.state,
    locked: false, user: viewerUser(), labels: [], milestone: null, comments: 0, review_comments: 0,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: p.state === 'closed' ? FIXED_ISO : null,
    merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha, merged: p.merged, mergeable: prMergeable(r, p),
    mergeable_state: prMergeable(r, p) === 'MERGEABLE' ? 'clean' : 'dirty', merged_by: p.merged ? viewerUser() : null,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`, url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    head: { label: `${r.owner}:${p.head}`, ref: p.head, sha: p.headSha, user: viewerUser(), repo: repoJson(r) },
    base: { label: `${r.owner}:${p.base}`, ref: p.base, sha: p.baseSha, user: viewerUser(), repo: repoJson(r) },
    author_association: 'OWNER', draft: false, commits: 1, additions: p.files.reduce((s, f) => s + f.additions, 0),
    deletions: p.files.reduce((s, f) => s + f.deletions, 0), changed_files: p.files.length,
  };
}
function getRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER) return null;
  return repos.get(`${owner}/${name}`) ?? null;
}
function createRepoRecord(name: string, priv: boolean, description: string): Repo {
  const r: Repo = { id: repoIdCounter++, name, owner: VIEWER, description, priv, defaultBranch: 'main', seq: repos.size, refs: new Map(), objects: new Map(), issues: [], nextIssue: 1, labels: new Map(), pulls: [], nextPull: 1 };
  repos.set(`${VIEWER}/${name}`, r);
  return r;
}
function computePullFiles(repo: Repo, baseTip: string | null, headTip: string): Pull['files'] {
  const baseMap = baseTip ? fileMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const headMap = fileMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const files: Pull['files'] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path); const h = headMap.get(path);
    if (b && h && b.oid === h.oid) continue;
    const newContent = h ? repo.objects.get(h.oid)?.data.toString('utf8') ?? '' : '';
    const oldContent = b ? repo.objects.get(b.oid)?.data.toString('utf8') ?? '' : '';
    const newLines = newContent === '' ? 0 : newContent.split('\n').length;
    const oldLines = oldContent === '' ? 0 : oldContent.split('\n').length;
    if (!b) files.push({ filename: path, status: 'added', additions: Math.max(1, newLines), deletions: 0, changes: Math.max(1, newLines) });
    else if (!h) files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, oldLines), changes: Math.max(1, oldLines) });
    else files.push({ filename: path, status: 'modified', additions: Math.max(1, newLines), deletions: oldLines, changes: Math.max(1, newLines) + oldLines });
  }
  return files;
}
function prConflict(repo: Repo, p: Pull): boolean {
  const baseTip = refTip(repo, p.base);
  const mb = mergeBase(repo, baseTip, p.headSha);
  if (!mb) return false;
  const mbMap = fileMap(repo, parseCommit(repo.objects.get(mb)!.data).tree);
  const baseMap = baseTip ? fileMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree) : new Map();
  const headMap = fileMap(repo, parseCommit(repo.objects.get(p.headSha)!.data).tree);
  for (const [path, h] of headMap) {
    const m = mbMap.get(path); const b = baseMap.get(path);
    if (m && b && m.oid !== b.oid && m.oid !== h.oid && b.oid !== h.oid) return true;
    if (!m && b && !baseMap.has(path)) continue;
  }
  // also: file changed in base and deleted/changed differently in head
  for (const [path, b] of baseMap) {
    const m = mbMap.get(path); const h = headMap.get(path);
    if (m && m.oid !== b.oid && (!h || h.oid !== m.oid) && (!h || h.oid !== b.oid)) return true;
  }
  return false;
}
function prMergeable(repo: Repo, p: Pull): string {
  if (p.merged) return 'MERGEABLE';
  return prConflict(repo, p) ? 'CONFLICTING' : 'MERGEABLE';
}
function doMerge(repo: Repo, p: Pull): { ok: boolean; sha?: string } {
  if (p.merged) return { ok: true, sha: p.merge_commit_sha ?? undefined };
  if (prConflict(repo, p)) return { ok: false };
  const baseTip = refTip(repo, p.base);
  const mb = mergeBase(repo, baseTip, p.headSha);
  const baseMap = baseTip ? fileMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const headMap = fileMap(repo, parseCommit(repo.objects.get(p.headSha)!.data).tree);
  const mbMap = mb ? fileMap(repo, parseCommit(repo.objects.get(mb)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const merged = new Map(baseMap);
  for (const [path, h] of headMap) { const m = mbMap.get(path); if (!m || m.oid !== h.oid) merged.set(path, h); }
  for (const path of [...mbMap.keys()]) { if (!headMap.has(path) && baseMap.has(path) && mbMap.get(path)?.oid === baseMap.get(path)?.oid) merged.delete(path); }
  const tree = treeFromMap(repo, merged);
  const ts = BASE_EPOCH + commitSeq++;
  const msg = `Merge pull request #${p.number} from ${VIEWER}/${p.head}\n\n${p.title}`;
  const sha = putObject(repo, 'commit', buildCommit(tree, baseTip ? [baseTip] : [], msg, ts));
  repo.refs.set(`refs/heads/${p.base}`, sha);
  p.merged = true; p.state = 'closed'; p.merged_at = FIXED_ISO; p.merge_commit_sha = sha;
  p.baseSha = sha;
  return { ok: true, sha };
}
function createIssueRecord(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
  for (const name of labelNames) if (!repo.labels.has(name)) return { error: `Label does not exist: ${name}` };
  const issue: Issue = { number: repo.nextIssue++, id: repo.id * 100000 + repo.nextIssue, title, body: body ?? '', state: 'open', labels: labelNames.map((n) => repo.labels.get(n)!), seq: repo.issues.length, comments: [] };
  issue.id = repo.id * 100000 + issue.number;
  repo.issues.push(issue);
  return issue;
}
function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = refTip(repo, head); const baseSha = refTip(repo, base);
  if (!headSha || !baseSha) return null;
  const files = computePullFiles(repo, baseSha, headSha);
  const pull: Pull = { number: repo.nextPull++, id: repo.id * 100000 + repo.nextPull, title, body: body ?? '', state: 'open', merged: false, merged_at: null, merge_commit_sha: null, head, base, headSha, baseSha, seq: repo.pulls.length, files };
  pull.id = repo.id * 100000 + pull.number;
  repo.pulls.push(pull);
  return pull;
}
function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  return { page: items.slice((pageNum - 1) * perPage, pageNum * perPage), total: items.length, pageNum, perPage };
}
function linkHeader(req: IncomingMessage, q: URLSearchParams, total: number, pageNum: number, perPage: number): string | null {
  if (pageNum * perPage >= total) return null;
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  url.searchParams.set('page', String(pageNum + 1));
  url.searchParams.set('per_page', String(perPage));
  return `<${url.toString()}>; rel="next"`;
}
function listWithLink<T>(res: ServerResponse, req: IncomingMessage, q: URLSearchParams, items: T[]): void {
  const { page, total, pageNum, perPage } = paginate(items, q);
  const extra: Record<string, string> = {};
  const link = linkHeader(req, q, total, pageNum, perPage);
  if (link) extra.link = link;
  sendJson(res, 200, page, extra);
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  if (!authed(req)) { unauthorized(res); return true; }
  const q = queryOf(req);
  const bodyBuf = method === 'GET' || method === 'HEAD' || method === 'DELETE' && false ? Buffer.alloc(0) : await readBody(req);
  // DELETE /contents carries a body; read it too (already read above for non-GET)
  let body: unknown = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) { badRequest(res, 'Invalid JSON'); return true; }
    body = parsed.value;
  }
  const b = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const segs = path.split('/').filter((s) => s !== '');
  // segs[0]=api, segs[1]=v3
  const rest = segs.slice(2);
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

  if (rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: 'https://github.com/settings/applications', authorizations_url: '/api/v3/authorizations', code_search_url: '/api/v3/search/code?q={query}', commit_search_url: '/api/v3/search/commits?q={query}', emails_url: '/api/v3/user/emails', emojis_url: '/api/v3/emojis', events_url: '/api/v3/events', feeds_url: '/api/v3/feeds', followers_url: '/api/v3/user/followers', following_url: '/api/v3/user/following{/target}', gists_url: '/api/v3/gists{/gist_id}', hub_url: 'https://api.github.com/hub', issue_search_url: '/api/v3/search/issues?q={query}', issues_url: '/api/v3/issues', keys_url: '/api/v3/user/keys', label_search_url: '/api/v3/search/labels?q={query}', notifications_url: '/api/v3/notifications', organizations_url: '/api/v3/user/orgs', public_gists_url: '/api/v3/gists/public', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}', repository_search_url: '/api/v3/search/repositories?q={query}', current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}', starred_url: '/api/v3/user/starred{/owner}{/repo}', starred_gists_url: '/api/v3/gists/starred', topic_search_url: '/api/v3/search/topics?q={query}', user_url: '/api/v3/users/{user}', user_organizations_url: '/api/v3/users/{user}/orgs', user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}', user_search_url: '/api/v3/search/users?q={query}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest[0] === 'meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }); return true; }
  if (rest[0] === 'rate_limit' && method === 'GET') { sendJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 }, resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } } }); return true; }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') { sendJson(res, 200, viewerUser()); return true; }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER).sort((a, b2) => a.seq - b2.seq).map(repoJson);
      listWithLink(res, req, q, all); return true;
    }
    if (method === 'POST') {
      const name = String(b(body).name ?? '');
      if (name === '') { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return true; }
      if (repos.has(`${VIEWER}/${name}`)) { sendJson(res, 422, { message: 'Repository already exists' }); return true; }
      const r = createRepoRecord(name, b(body).private === true, String(b(body).description ?? ''));
      sendJson(res, 201, repoJson(r)); return true;
    }
  }
  if (rest[0] === 'users' && rest.length === 2 && method === 'GET') {
    if (dec(rest[1]) === VIEWER) { sendJson(res, 200, viewerUser()); return true; }
    notFound(res); return true;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = dec(rest[1]); const name = dec(rest[2]);
    const repo = getRepo(owner, name);
    if (!repo) { notFound(res, 'Not Found'); return true; }
    const tail = rest.slice(3);
    // GET /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof b(body).description === 'string') repo.description = b(body).description as string;
        if (typeof b(body).default_branch === 'string') repo.defaultBranch = b(body).default_branch as string;
        sendJson(res, 200, repoJson(repo)); return true;
      }
      if (method === 'DELETE') {
        repos.delete(`${owner}/${name}`);
        res.writeHead(204, { 'x-github-request-id': reqId() }); res.end(); return true;
      }
      notFound(res); return true;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
        sendJson(res, 200, list.map((n) => ({ name: n, commit: { sha: repo.refs.get(`refs/heads/${n}`), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${n}`)}` }, protected: false })));
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${dec(tail[1])}`);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, { name: dec(tail[1]), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
        return true;
      }
    }
    // commits
    if (tail[0] === 'commits' && method === 'GET') {
      if (tail.length === 2) {
        const oid = dec(tail[1]);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') { notFound(res); return true; }
        const c = parseCommit(obj.data);
        sendJson(res, 200, commitJson(repo, oid, c)); return true;
      }
      const shaParam = q.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        if (repo.refs.has(`refs/heads/${shaParam}`)) tip = repo.refs.get(`refs/heads/${shaParam}`)!;
        else if (repo.objects.has(shaParam)) tip = shaParam;
        else { sendJson(res, 200, []); return true; }
      } else tip = refTip(repo, repo.defaultBranch);
      const list = ancestors(repo, tip).map((oid) => commitJson(repo, oid, parseCommit(repo.objects.get(oid)!.data)));
      listWithLink(res, req, q, list); return true;
    }
    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = String(b(body).ref ?? ''); const sha = String(b(body).sha ?? '');
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', repo.id, ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return true;
      }
      if (method === 'GET') {
        const wanted = tail.slice(2).map(dec).join('/');
        if (wanted === '') {
          sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: gid('Ref', repo.id, ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit' } })));
          return true;
        }
        const full = `refs/${wanted}`;
        const sha = repo.refs.get(full);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, { ref: full, node_id: gid('Ref', repo.id, full), url: `/api/v3/repos/${owner}/${name}/git/refs/${wanted}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return true;
      }
      if (method === 'PATCH' && tail.length >= 3) {
        const full = `refs/${tail.slice(2).map(dec).join('/')}`;
        const sha = String(b(body).sha ?? '');
        if (!repo.refs.has(full) || !repo.objects.has(sha)) { notFound(res); return true; }
        repo.refs.set(full, sha);
        sendJson(res, 200, { ref: full, object: { sha, type: 'commit' } }); return true;
      }
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(dec).join('/');
      if (method === 'PUT') {
        const branch = typeof b(body).branch === 'string' ? (b(body).branch as string) : repo.defaultBranch;
        if (!repo.refs.has(`refs/heads/${branch}`)) {
          const baseTip = refTip(repo, repo.defaultBranch);
          if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
          else repo.refs.set(`refs/heads/${branch}`, '');
        }
        const contentB64 = String(b(body).content ?? '');
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64'); } catch { badRequest(res, 'Invalid base64 content'); return true; }
        const message = String(b(body).message ?? 'Update file');
        const tip = refTip(repo, branch);
        const map = tip ? fileMap(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
        const existing = map.get(filePath);
        const newBlobSha = hashObject('blob', content);
        if (existing && typeof b(body).sha === 'string' && (b(body).sha as string).toLowerCase() !== existing.oid.toLowerCase()) { sendJson(res, 409, { message: 'sha does not match' }); return true; }
        if (!existing && typeof b(body).sha === 'string') { sendJson(res, 409, { message: 'sha does not match' }); return true; }
        const isCreate = !existing;
        const sha = commitForBranch(repo, branch, new Map([[filePath, content]]), message);
        const blobSha = putObject(repo, 'blob', content);
        sendJson(res, isCreate ? 201 : 200, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`, html_url: `https://github.com/${owner}/${name}/blob/${branch}/${filePath}`, git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobSha}`, download_url: '', type: 'file', encoding: 'base64', content: content.toString('base64') }, commit: { sha, message, author: viewerUser(), committer: viewerUser() } });
        return true;
      }
      if (method === 'GET') {
        const refParam = q.get('ref');
        let tip: string | null = null;
        if (refParam) {
          if (repo.refs.has(`refs/heads/${refParam}`)) tip = repo.refs.get(`refs/heads/${refParam}`)!;
          else if (repo.objects.has(refParam)) tip = refParam;
          else { notFound(res); return true; }
        } else tip = refTip(repo, repo.defaultBranch);
        if (!tip) { notFound(res); return true; }
        const map = fileMap(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        if (filePath === '') {
          const top = new Map<string, { oid: string; mode: string; type: string }>();
          for (const [p, e] of map) { const seg = p.split('/')[0]; if (!top.has(seg)) top.set(seg, { oid: e.oid, mode: e.mode, type: p.includes('/') ? 'dir' : 'file' }); }
          sendJson(res, 200, [...top.entries()].map(([n, e]) => ({ type: e.type, name: n, path: n, sha: e.oid, size: e.type === 'file' ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0, url: `/api/v3/repos/${owner}/${name}/contents/${n}`, html_url: '', git_url: '', download_url: '' })));
          return true;
        }
        const file = map.get(filePath);
        if (file) {
          const data = repo.objects.get(file.oid)!.data;
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: data.toString('base64'), sha: file.oid, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`, html_url: '', git_url: '', download_url: '' });
          return true;
        }
        // directory?
        const prefix = filePath + '/';
        const children = new Map<string, { oid: string; mode: string; type: string }>();
        for (const [p, e] of map) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length); const seg = restPath.split('/')[0];
          if (!children.has(seg)) children.set(seg, { oid: e.oid, mode: e.mode, type: restPath.includes('/') ? 'dir' : 'file' });
        }
        if (children.size) {
          sendJson(res, 200, [...children.entries()].map(([n, e]) => ({ type: e.type, name: n, path: `${filePath}/${n}`, sha: e.oid, size: e.type === 'file' ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}/${n}`, html_url: '', git_url: '', download_url: '' })));
          return true;
        }
        notFound(res); return true;
      }
      if (method === 'DELETE') {
        const branch = typeof b(body).branch === 'string' ? (b(body).branch as string) : repo.defaultBranch;
        const tip = refTip(repo, branch);
        if (!tip) { notFound(res); return true; }
        const map = fileMap(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        if (!map.has(filePath)) { notFound(res); return true; }
        const sha = deleteFromBranch(repo, branch, filePath, String(b(body).message ?? 'Delete file'));
        sendJson(res, 200, { commit: { sha, message: String(b(body).message ?? 'Delete file') } });
        return true;
      }
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const name = String(b(body).name ?? '');
        if (name === '') { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return true; }
        const label = { name, color: String(b(body).color ?? 'ededed') };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: 1, node_id: gid('Label', repo.id, name), name, color: label.color, description: '', default: false });
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: 1, node_id: gid('Label', repo.id, l.name), name: l.name, color: l.color, description: '', default: false })));
        return true;
      }
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = String(b(body).title ?? '');
          const labelsRaw = b(body).labels;
          const labelNames: string[] = Array.isArray(labelsRaw) ? labelsRaw.map((l) => typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? '')) : [];
          const created = createIssueRecord(repo, title, String(b(body).body ?? ''), labelNames);
          if ('error' in created) { sendJson(res, 422, { message: created.error }); return true; }
          sendJson(res, 201, issueJson(repo, created)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.issues];
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          if (q.get('sort') === 'created') list.sort((a, b2) => (q.get('direction') === 'asc' ? a.seq - b2.seq : b2.seq - a.seq));
          else list.sort((a, b2) => b2.seq - a.seq);
          listWithLink(res, req, q, list.map((i) => issueJson(repo, i))); return true;
        }
      }
      const num = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof b(body).state === 'string' && (b(body).state === 'open' || b(body).state === 'closed')) issue.state = b(body).state as 'open' | 'closed';
          if (typeof b(body).title === 'string') issue.title = b(body).title as string;
          if (typeof b(body).body === 'string') issue.body = b(body).body as string;
          sendJson(res, 200, issueJson(repo, issue)); return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'POST') {
          const comment = { id: commentIdCounter++, body: String(b(body).body ?? ''), seq: issue.comments.length };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, node_id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body, user: viewerUser(), created_at: FIXED_ISO, updated_at: FIXED_ISO, html_url: '', url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}` });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body, user: viewerUser(), created_at: FIXED_ISO, updated_at: FIXED_ISO })));
          return true;
        }
      }
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const head = String(b(body).head ?? ''); const base = String(b(body).base ?? repo.defaultBranch);
          const pull = createPullRecord(repo, String(b(body).title ?? ''), String(b(body).body ?? ''), head, base);
          if (!pull) { sendJson(res, 422, { message: 'Head branch does not exist' }); return true; }
          sendJson(res, 201, pullJson(repo, pull)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b2) => b2.seq - a.seq);
          listWithLink(res, req, q, list.map((p) => pullJson(repo, p))); return true;
        }
      }
      const num = parseInt(tail[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: '', blob_url: '', raw_url: '', contents_url: '', patch: '' })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return true; }
        if (pull.merged) { sendJson(res, 200, { sha: pull.merge_commit_sha, merged: true, message: 'Pull request successfully merged' }); return true; }
        if (prConflict(repo, pull)) { sendJson(res, 405, { message: 'Merge conflict' }); return true; }
        const merged = doMerge(repo, pull);
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' }); return true;
      }
    }
  }
  notFound(res);
  return true;
}
function commitJson(repo: Repo, sha: string, c: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const ts = parseInt((c.author.match(/ (\d+) \+0000$/)?.[1]) ?? '1735689600', 10);
  const iso = new Date(ts * 1000).toISOString();
  const authorName = c.author.replace(/ <[^>]*>.*$/, '');
  return {
    sha, node_id: gid('Commit', repo.id, sha), commit: { author: { name: authorName, email: VIEWER_EMAIL, date: iso }, committer: { name: authorName, email: VIEWER_EMAIL, date: iso }, message: c.message.replace(/\n+$/, ''), tree: { sha: c.tree, url: '' }, url: '', comment_count: 0, verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null } },
    url: '', html_url: '', comments_url: '', author: viewerUser(), committer: viewerUser(), parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------- Git smart HTTP
function advertisedRefs(repo: Repo, v2: boolean): { ref: string; oid: string; unborn: boolean }[] {
  void v2;
  if (!repo.refs.size) return [];
  const out: { ref: string; oid: string; unborn: boolean }[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) out.push({ ref, oid, unborn: false });
  return out;
}
function handleInfoRefs(repo: Repo, service: string, req: IncomingMessage, res: ServerResponse): void {
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const refs = advertisedRefs(repo, wantsV2);
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const lines: Buffer[] = [];
      lines.push(pkt('version 2\n'));
      lines.push(pkt('ls-refs\n'));
      lines.push(pkt('fetch=shallow wait-for-done filter\n'));
      lines.push(pkt('server-option\n'));
      lines.push(pkt('object-format=sha1\n'));
      lines.push(FLUSH);
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
      return;
    }
    const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want symref=HEAD:refs/heads/main agent=git/2.43.0';
    const parts: Buffer[] = [];
    parts.push(pkt(`# service=git-upload-pack\n`));
    parts.push(FLUSH);
    if (!refs.length) {
      // Empty repo: the capabilities^{} pseudo-ref only, per git's v0 advertisement.
      parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      parts.push(FLUSH);
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
      return;
    }
    const head = refs.find((r) => r.ref === `refs/heads/${repo.defaultBranch}`);
    const headOid = head ? head.oid : ZERO_OID;
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pkt(`${r.oid} ${r.ref}\n`));
      if (r.ref.startsWith('refs/tags/')) {
        const tagObj = repo.objects.get(r.oid);
        if (tagObj?.type === 'tag') parts.push(pkt(`${parseTag(tagObj.data).object} ${r.ref}^{}\n`));
      }
    }
    parts.push(FLUSH);
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }
  // receive-pack (v0)
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet object-format=sha1 agent=git/2.43.0';
  const parts: Buffer[] = [];
  parts.push(pkt('# service=git-receive-pack\n'));
  parts.push(FLUSH);
  if (!refs.length) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(FLUSH);
    sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(parts));
    return;
  }
  const head = refs.find((r) => r.ref === `refs/heads/${repo.defaultBranch}`);
  const headOid = head ? head.oid : ZERO_OID;
  parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
  for (const r of refs) {
    parts.push(pkt(`${r.oid} ${r.ref}\n`));
    if (r.ref.startsWith('refs/tags/')) {
      const tagObj = repo.objects.get(r.oid);
      if (tagObj?.type === 'tag') parts.push(pkt(`${parseTag(tagObj.data).object} ${r.ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(parts));
}
function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (!v2) { handleUploadPackV0(repo, res, body); return; }
  let lines: ReturnType<typeof decodePktLines>;
  try { lines = decodePktLines(body); } catch { sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.alloc(0)); return; }
  let command = '';
  const wants: string[] = []; const haves: string[] = [];
  const shallowWants: string[] = [];
  let deepen: number | null = null; let deepenSince: number | null = null; let deepenNot: string[] = [];
  let refPrefix: string[] = []; let refPeel = false; let refSymrefs = false; let refUnborn = false; let filter = false;
  let inArgs = false;
  for (const line of lines) {
    if (line.kind === 'delim') { inArgs = true; continue; }
    if (line.kind !== 'data' || !line.payload) continue;
    const s = line.payload.toString('utf8');
    if (!inArgs) {
      if (s.startsWith('command=')) command = s.slice('command='.length).trim();
      else if (s.startsWith('object-format=')) { /* ignore */ }
    } else if (command === 'ls-refs') {
      if (s.trim() === 'peel') refPeel = true;
      else if (s.trim() === 'symrefs') refSymrefs = true;
      else if (s.trim() === 'unborn') refUnborn = true;
      else if (s.startsWith('ref-prefix ')) refPrefix.push(s.slice('ref-prefix '.length).trim());
      else if (s.startsWith('ref-prefix\t')) refPrefix.push(s.slice('ref-prefix\t'.length).trim());
    } else if (command === 'fetch') {
      if (s.startsWith('want ')) wants.push(s.slice(5, 45));
      else if (s.startsWith('have ')) haves.push(s.slice(5, 45));
      else if (s.startsWith('shallow ')) shallowWants.push(s.slice(8, 48));
      else if (s.startsWith('deepen ')) deepen = parseInt(s.slice(7).trim(), 10);
      else if (s.startsWith('deepen-since ')) deepenSince = parseInt(s.slice('deepen-since '.length).trim(), 10);
      else if (s.startsWith('deepen-not ')) deepenNot.push(s.slice('deepen-not '.length).trim());
      else if (s.startsWith('filter ')) filter = true;
    }
  }
  if (command === 'ls-refs') {
    const out: Buffer[] = [];
    const refs = advertisedRefs(repo, true);
    // HEAD with its symref-target attribute on one line, only when no ref-prefix
    // filters the reply (a prefix reply must contain only matching refs).
    if (refSymrefs && !refPrefix.length) {
      const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (headOid) out.push(pkt(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const r of refs) {
      if (refPrefix.length && !refPrefix.some((p) => r.ref.startsWith(p))) continue;
      let line = `${r.oid} ${r.ref}`;
      if (refPeel && r.ref.startsWith('refs/tags/')) {
        const tagObj = repo.objects.get(r.oid);
        if (tagObj?.type === 'tag') line += ` peeled:${parseTag(tagObj.data).object}`;
      }
      out.push(pkt(`${line}\n`));
    }
    out.push(FLUSH);
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  if (command === 'fetch') {
    // resolve wanted tips
    const wantedTips: string[] = [];
    for (const w of wants) if (repo.objects.has(w)) wantedTips.push(w);
    const selection = selectFetch(repo, wantedTips, haves, { depth: deepen, deepenSince, deepenNot, shallowBoundaries: shallowWants });
    const toSend = selection.send;
    const shallowSet = selection.shallow;
    const unshallowSet = selection.unshallow;
    void filter;
    // Build sections
    const parts: Buffer[] = [];
    // acknowledgments
    parts.push(pkt('acknowledgments\n'));
    const haveSet = collectReachableBounded(repo, haves, new Set(shallowWants));
    const allHave = wants.length > 0 && wants.every((w) => haveSet.has(w));
    if (haves.length === 0) parts.push(pkt('NAK\n'));
    else if (allHave) { parts.push(pkt('ready\n')); for (const h of haves) if (repo.objects.has(h)) parts.push(pkt(`ACK ${h}\n`)); }
    else parts.push(pkt('NAK\n'));
    parts.push(DELIM);
    // shallow-info
    parts.push(pkt('shallow-info\n'));
    for (const s of [...shallowSet].sort()) parts.push(pkt(`shallow ${s}\n`));
    for (const s of [...unshallowSet].sort()) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(DELIM);
    // wanted-refs
    parts.push(pkt('wanted-refs\n'));
    for (const tip of wantedTips) {
      for (const [ref, oid] of repo.refs) if (oid === tip) parts.push(pkt(`${tip} ${ref}\n`));
    }
    parts.push(DELIM);
    // packfile — emitted only when there are objects to send; an empty
    // packfile section is a protocol error for the client.
    const objs: GitObject[] = [];
    if (toSend.size) for (const oid of [...toSend].sort()) { const o = repo.objects.get(oid); if (o) objs.push(o); }
    if (objs.length) {
      parts.push(pkt('packfile\n'));
      const pack = cachedPack(repo, objs, packCacheKey(repo, wants, haves, deepen, deepenSince, deepenNot, shallowWants));
      for (const b of sideband(pack)) parts.push(b);
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.alloc(0));
}
function handleUploadPackV0(repo: Repo, res: ServerResponse, body: Buffer): void {
  const lines = body.toString('utf8').split('\n');
  const wants: string[] = []; const haves: string[] = [];
  const shallowWants: string[] = [];
  let deepen: number | null = null; let deepenSince: number | null = null; let deepenNot: string[] = [];
  let section = 0;
  for (const line of lines) {
    const s = line.trim();
    if (s === '') { section += 1; continue; }
    if (section === 0) {
      if (s.startsWith('want ')) wants.push(s.slice(5, 45));
      else if (s.startsWith('shallow ')) shallowWants.push(s.slice(8, 48));
      else if (s.startsWith('deepen ')) deepen = parseInt(s.slice(7).trim(), 10);
      else if (s.startsWith('deepen-since ')) deepenSince = parseInt(s.slice('deepen-since '.length).trim(), 10);
      else if (s.startsWith('deepen-not ')) deepenNot.push(s.slice('deepen-not '.length).trim());
    } else {
      if (s.startsWith('have ')) haves.push(s.slice(5, 45));
    }
  }
  void shallowWants;
  const wantedTips = wants.filter((w) => repo.objects.has(w));
  const selection = selectFetch(repo, wantedTips, haves, { depth: deepen, deepenSince, deepenNot, shallowBoundaries: shallowWants });
  const toSend = selection.send;
  const shallowSet = selection.shallow;
  const textLines: Buffer[] = [];
  const haveSet = collectReachableBounded(repo, haves, new Set(shallowWants));
  const allHave = wants.length > 0 && wants.every((w) => haveSet.has(w));
  if (haves.length === 0) textLines.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from('NAK\n')])));
  else if (allHave) textLines.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from('ready\n')])));
  else textLines.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from('NAK\n')])));
  for (const s of [...shallowSet].sort()) textLines.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`shallow ${s}\n`)])));
  for (const s of [...selection.unshallow].sort()) textLines.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`unshallow ${s}\n`)])));
  const objs: GitObject[] = [];
  if (toSend.size) for (const oid of [...toSend].sort()) { const o = repo.objects.get(oid); if (o) objs.push(o); }
  if (objs.length) {
    const pack = cachedPack(repo, objs, packCacheKey(repo, wants, haves, deepen, deepenSince, deepenNot, shallowWants));
    for (const b of sideband(pack)) textLines.push(b);
  }
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(textLines));
}
function handleReceivePack(repo: Repo, res: ServerResponse, body: Buffer): void {
  // body: pkt-lines of "<old> <new> <ref>" (+ first line may carry \0 caps), flush, then pack bytes.
  // Walk pkt-lines properly: a naive search for "0000" matches the all-zero old-OID of a first push.
  let flushEnd = -1;
  {
    let off = 0;
    while (off + 4 <= body.length) {
      const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len) || len < 0 || off + len > body.length) break;
      if (len === 0) { flushEnd = off + 4; break; }
      off += len;
    }
  }
  if (flushEnd < 0) { sendReceiveReport(res, [], 'unpack ok'); return; }
  const commandPart = body.subarray(0, flushEnd);
  const packPart = body.subarray(flushEnd);
  let lines: ReturnType<typeof decodePktLines>;
  try { lines = decodePktLines(commandPart); } catch { sendReceiveReport(res, [], 'unpack ok'); return; }
  interface Cmd { old: string; nw: string; ref: string }
  const commands: Cmd[] = [];
  for (const line of lines) {
    if (line.kind !== 'data' || !line.payload) continue;
    let s = line.payload.toString('utf8');
    const nul = s.indexOf('\0');
    if (nul >= 0) s = s.slice(0, nul);
    const parts = s.trim().split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) commands.push({ old: parts[0], nw: parts[1], ref: parts[2] });
  }
  // Parse pack if present and needed
  const needsPack = commands.some((c) => c.nw !== ZERO_OID);
  let packObjects: Map<string, GitObject> | null = null;
  let unpackOk = true;
  if (needsPack) {
    if (packPart.length < 12) unpackOk = false;
    else {
      try {
        packObjects = readPack(packPart, (oid) => repo.objects.get(oid));
      } catch { unpackOk = false; }
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (!unpackOk) {
    sendReceiveReport(res, commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' })), 'unpack failed');
    return;
  }
  if (packObjects) for (const [oid, obj] of packObjects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.nw === ZERO_OID) {
      // delete
      if (!current) { results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' }); continue; }
      if (cmd.old !== ZERO_OID && cmd.old !== current) { results.push({ ref: cmd.ref, ok: false, reason: 'ref has changed' }); continue; }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // new ref value must exist
    if (!repo.objects.has(cmd.nw) || (repo.objects.get(cmd.nw)!.type !== 'commit' && repo.objects.get(cmd.nw)!.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue;
    }
    if (cmd.old === ZERO_OID) {
      if (current) { results.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.nw);
      results.push({ ref: cmd.ref, ok: true }); continue;
    }
    if (!current) { results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' }); continue; }
    if (current !== cmd.old) { results.push({ ref: cmd.ref, ok: false, reason: 'ref has changed' }); continue; }
    // fast-forward check (early-exit walk from the new tip)
    if (current !== cmd.nw && !isAncestor(repo, current, cmd.nw)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue;
    }
    repo.refs.set(cmd.ref, cmd.nw);
    results.push({ ref: cmd.ref, ok: true });
  }
  sendReceiveReport(res, results, 'unpack ok');
}
function sendReceiveReport(res: ServerResponse, results: { ref: string; ok: boolean; reason?: string }[], unpack: string): void {
  // With side-band-64k the report-status stream is itself pkt-lined inside band 1.
  const inner: Buffer[] = [pkt(`${unpack}\n`)];
  for (const r of results) inner.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'error'}\n`));
  inner.push(FLUSH);
  const stream = Buffer.concat(inner);
  const out: Buffer[] = [];
  for (let i = 0; i < stream.length; i += 60000) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), stream.subarray(i, i + 60000)])));
  }
  sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}
async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) return false;
  const owner = m[1]; const name = m[2]; const svc = m[3];
  const repo = getRepo(owner, name);
  if (!repo) {
    if (method === 'GET' && svc === 'info/refs') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return true; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return true;
  }
  if (method === 'GET' && svc === 'info/refs') {
    const service = queryOf(req).get('service') ?? '';
    if (service === 'git-upload-pack' || service === 'git-receive-pack') { handleInfoRefs(repo, service, req, res); return true; }
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Bad Request'); return true;
  }
  if (method === 'POST' && svc === 'git-upload-pack') {
    const body = await readBody(req);
    try { handleUploadPack(repo, req, res, body); } catch { sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.alloc(0)); }
    return true;
  }
  if (method === 'POST' && svc === 'git-receive-pack') {
    const body = await readBody(req);
    try { handleReceivePack(repo, res, body); } catch { sendReceiveReport(res, [], 'unpack failed'); }
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found');
  return true;
}

// ---------------------------------------------------------------- GraphQL v4
interface GQLIssueFilter { states?: string[]; }
function cursorFor(repo: Repo, issue: Issue): string {
  return Buffer.from(`cursor:${repo.id}:${issue.number}`).toString('base64');
}
function decodeGid(gidStr: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(gidStr, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}
function gqlRepoById(id: string): Repo | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Repository') return null;
  const dbId = parseInt(d.parts[0], 10);
  for (const r of repos.values()) if (r.id === dbId) return r;
  return null;
}
function gqlIssueById(id: string): { repo: Repo; issue: Issue } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Issue') return null;
  const repo = [...repos.values()].find((r) => r.id === parseInt(d.parts[0], 10));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === parseInt(d.parts[1], 10));
  if (!issue) return null;
  return { repo, issue };
}
function gqlPullById(id: string): { repo: Repo; pull: Pull } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'PullRequest') return null;
  const repo = [...repos.values()].find((r) => r.id === parseInt(d.parts[0], 10));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === parseInt(d.parts[1], 10));
  if (!pull) return null;
  return { repo, pull };
}
// Minimal GraphQL document handling: parse fields via a tiny tokenizer that
// understands the documents the suite sends (variables, inline enums, inline
// input objects, fragments not used).
function gqlRepoFields(repo: Repo): Record<string, unknown> {
  return {
    id: repoGid(repo), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: gid('User', VIEWER_ID), databaseId: VIEWER_ID },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
  };
}
function gqlIssueFields(repo: Repo, i: Issue): Record<string, unknown> {
  return { id: issueGid(repo, i), databaseId: i.id, number: i.number, title: i.title, body: i.body, state: i.state === 'open' ? 'OPEN' : 'CLOSED', createdAt: FIXED_ISO, updatedAt: FIXED_ISO, labels: { nodes: i.labels.map((l) => ({ name: l.name })) } };
}
function gqlPullFields(repo: Repo, p: Pull): Record<string, unknown> {
  return { id: pullGid(repo, p), databaseId: p.id, number: p.number, title: p.title, body: p.body, state: p.state === 'open' ? 'OPEN' : 'CLOSED', merged: p.merged, headRefName: p.head, baseRefName: p.base, mergeable: prMergeable(repo, p), mergedAt: p.merged_at, mergeCommit: p.merge_commit_sha ? { oid: p.merge_commit_sha } : null, files: { nodes: p.files.map((f) => ({ path: f.filename })), totalCount: p.files.length } };
}
interface GQLField { name: string; alias: string; args: Record<string, unknown>; children: GQLField[]; inlineFragments: GQLField[] }
function tokenizeGQL(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      i += 3; while (!(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) i += 1; i += 3; continue;
    }
    if (ch === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j += 1; j += 1; } tokens.push(src.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === '$') { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1; tokens.push(src.slice(i, j)); i = j; continue; }
    if (/[A-Za-z0-9_]/.test(ch)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1; tokens.push(src.slice(i, j)); i = j; continue; }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') { tokens.push('...'); i += 3; continue; }
    tokens.push(ch); i += 1;
  }
  return tokens;
}
class GQLParser {
  pos = 0;
  tokens: string[];
  vars: Record<string, unknown>;
  constructor(tokens: string[], vars: Record<string, unknown>) { this.tokens = tokens; this.vars = vars; }
  peek(): string { return this.tokens[this.pos] ?? ''; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(): unknown {
    const t = this.next();
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const key = this.next(); this.expect(':'); obj[key] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return obj;
    }
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) { arr.push(this.parseValue()); if (this.peek() === ',') this.next(); }
      this.expect(']');
      return arr;
    }
    if (t.startsWith('$')) return this.vars[t.slice(1)];
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    return t; // enum as string
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')' && this.pos < this.tokens.length) {
      const key = this.next(); this.expect(':'); args[key] = this.parseValue();
      if (this.peek() === ',') this.next();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GQLField[] {
    this.expect('{');
    const fields: GQLField[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') { this.next(); this.next(); }
        const children = this.peek() === '{' ? this.parseSelectionSet() : [];
        fields.push({ name: '__fragment', alias: '__fragment', args: {}, children, inlineFragments: [] });
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      fields.push({ name, alias, args, children, inlineFragments: [] });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(): { opType: string; fields: GQLField[] } {
    let opType = 'query';
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === 'query' || t === 'mutation' || t === 'subscription') { opType = this.next(); }
      if (this.peek() === '(') { // variable definitions: skip
        let depth = 0;
        while (this.pos < this.tokens.length) { const tok = this.next(); if (tok === '(') depth += 1; if (tok === ')') { depth -= 1; if (depth === 0) break; } }
      }
      if (this.peek() === '{') break;
      // operation name
      this.next();
    }
    const fields = this.parseSelectionSet();
    return { opType, fields };
  }
}
function gqlRepoTypeFields(): string[] {
  return ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount', 'primaryLanguage'];
}
function gqlIssueTypeFields(): string[] { return ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository']; }
function gqlPullTypeFields(): string[] { return ['id', 'databaseId', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'headRefOid', 'baseRefOid', 'mergeCommit']; }
function typeFields(name: string): string[] | null {
  switch (name) {
    case 'Repository': return gqlRepoTypeFields();
    case 'Issue': return gqlIssueTypeFields();
    case 'PullRequest': return gqlPullTypeFields();
    case 'User': return ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'];
    case 'IssueComment': return ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'];
    default: return null;
  }
}
interface GQLError { message: string }
function executeGQL(query: string, variables: Record<string, unknown>, operationName?: string): { data?: Record<string, unknown>; errors?: GQLError[] } {
  let op: { opType: string; fields: GQLField[] };
  try {
    const parser = new GQLParser(tokenizeGQL(query), variables);
    op = parser.parseOperation();
  } catch (e) {
    return { errors: [{ message: String(e) }] };
  }
  void operationName;
  const errors: GQLError[] = [];
  const data: Record<string, unknown> = {};
  const resolveRepo = (fields: GQLField[]): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.name === '__fragment') { Object.assign(out, resolveRepo(f.children)); continue; }
      out[f.alias] = undefined;
    }
    return out;
  };
  void resolveRepo;
  const resolveIssueFields = (repo: Repo, issue: Issue, fields: GQLField[]): Record<string, unknown> => {
    const base = gqlIssueFields(repo, issue);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.name === '__fragment') { Object.assign(out, resolveIssueFields(repo, issue, f.children)); continue; }
      if (f.name === 'labels' && f.children.length) out[f.alias] = { nodes: issue.labels.map((l) => ({ name: l.name })), totalCount: issue.labels.length };
      else if (f.name === 'comments' && f.children.length) out[f.alias] = { nodes: issue.comments.map((c) => ({ id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body })), totalCount: issue.comments.length };
      else if (f.name === 'author') out[f.alias] = { login: VIEWER };
      else if (f.name === 'repository') out[f.alias] = resolveRepoFields(repo, f.children);
      else if (f.name in base) out[f.alias] = base[f.name];
      else errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` });
    }
    return out;
  };
  const resolvePullFields = (repo: Repo, pull: Pull, fields: GQLField[]): Record<string, unknown> => {
    const base = gqlPullFields(repo, pull);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.name === '__fragment') { Object.assign(out, resolvePullFields(repo, pull, f.children)); continue; }
      if (f.name === 'files' && f.children.length) {
        let nodes = pull.files.map((fl) => ({ path: fl.filename }));
        const first = typeof f.args.first === 'number' ? f.args.first : nodes.length;
        nodes = nodes.slice(0, first);
        out[f.alias] = { nodes, totalCount: pull.files.length };
      } else if (f.name === 'author') out[f.alias] = { login: VIEWER };
      else if (f.name in base) out[f.alias] = base[f.name];
      else errors.push({ message: `Cannot query field "${f.name}" on type "PullRequest".` });
    }
    return out;
  };
  const resolveRepoFields = (repo: Repo, fields: GQLField[]): Record<string, unknown> => {
    const base = gqlRepoFields(repo);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.name === '__fragment') { Object.assign(out, resolveRepoFields(repo, f.children)); continue; }
      if (f.name === 'issue') {
        const num = typeof f.args.number === 'number' ? f.args.number : parseInt(String(f.args.number ?? ''), 10);
        const issue = repo.issues.find((i) => i.number === num);
        out[f.alias] = issue ? resolveIssueFields(repo, issue, f.children) : null;
      } else if (f.name === 'issues') {
        let list = [...repo.issues];
        const states = f.args.states;
        if (Array.isArray(states) && states.length) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = f.args.orderBy as Record<string, unknown> | undefined;
        if (orderBy && orderBy.field === 'CREATED_AT') list.sort((a, b2) => (orderBy.direction === 'DESC' ? b2.number - a.number : a.number - b2.number));
        else list.sort((a, b2) => b2.number - a.number);
        let afterIdx = -1;
        if (typeof f.args.after === 'string' && f.args.after) {
          try { const dec2 = Buffer.from(f.args.after, 'base64').toString('utf8'); const parts = dec2.split(':'); const num = parseInt(parts[2], 10); afterIdx = list.findIndex((i) => i.number === num); } catch { /* ignore */ }
        }
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        const pageItems = list.slice(afterIdx + 1, afterIdx + 1 + first);
        const endCursor = pageItems.length ? cursorFor(repo, pageItems[pageItems.length - 1]) : null;
        out[f.alias] = {
          nodes: pageItems.map((i) => resolveIssueFields(repo, i, f.children.find((c) => c.name === 'nodes')?.children ?? [])),
          edges: pageItems.map((i) => ({ cursor: cursorFor(repo, i), node: resolveIssueFields(repo, i, f.children.find((c) => c.name === 'edges')?.children.find((c2) => c2.name === 'node')?.children ?? []) })),
          pageInfo: { hasNextPage: afterIdx + 1 + first < list.length, endCursor },
          totalCount: list.length,
        };
      } else if (f.name === 'pullRequests') {
        let list = [...repo.pulls].sort((a, b2) => b2.number - a.number);
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        list = list.slice(0, first);
        out[f.alias] = {
          nodes: list.map((p) => resolvePullFields(repo, p, f.children.find((c) => c.name === 'nodes')?.children ?? [])),
          edges: list.map((p) => ({ cursor: Buffer.from(`cursor:${repo.id}:pr:${p.number}`).toString('base64'), node: resolvePullFields(repo, p, f.children.find((c) => c.name === 'edges')?.children.find((c2) => c2.name === 'node')?.children ?? []) })),
          pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: list.length ? Buffer.from(`cursor:${repo.id}:pr:${list[list.length - 1].number}`).toString('base64') : null },
          totalCount: repo.pulls.length,
        };
      } else if (f.name === 'pullRequest') {
        const num = typeof f.args.number === 'number' ? f.args.number : parseInt(String(f.args.number ?? ''), 10);
        const pull = repo.pulls.find((p) => p.number === num);
        out[f.alias] = pull ? resolvePullFields(repo, pull, f.children) : null;
      } else if (f.name === 'owner') out[f.alias] = { login: repo.owner, id: gid('User', VIEWER_ID), databaseId: VIEWER_ID };
      else if (f.name === 'defaultBranchRef') out[f.alias] = repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null;
      else if (f.name in base) out[f.alias] = base[f.name];
      else errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` });
    }
    return out;
  };
  const resolveNode = (id: string, fields: GQLField[]): Record<string, unknown> | null => {
    const d = decodeGid(id);
    if (!d) return null;
    if (d.kind === 'Repository') { const r = gqlRepoById(id); return r ? resolveRepoFields(r, fields) : null; }
    if (d.kind === 'Issue') { const hit = gqlIssueById(id); return hit ? resolveIssueFields(hit.repo, hit.issue, fields) : null; }
    if (d.kind === 'PullRequest') { const hit = gqlPullById(id); return hit ? resolvePullFields(hit.repo, hit.pull, fields) : null; }
    return null;
  };
  for (const f of op.fields) {
    if (f.name === '__fragment') continue;
    if (op.opType === 'mutation') {
      if (f.name === 'createIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? gqlRepoById(input.repositoryId) : null;
        if (!repo) { data[f.alias] = null; errors.push({ message: 'Repository not found' }); continue; }
        const created = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) { data[f.alias] = null; errors.push({ message: created.error }); continue; }
        const issueSel = f.children.find((c) => c.name === 'issue');
        data[f.alias] = { issue: issueSel ? resolveIssueFields(repo, created, issueSel.children) : resolveIssueFields(repo, created, []) };
        continue;
      }
      if (f.name === 'closeIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const hit = typeof input.issueId === 'string' ? gqlIssueById(input.issueId) : null;
        if (!hit) { data[f.alias] = null; errors.push({ message: 'Issue not found' }); continue; }
        hit.issue.state = 'closed';
        const issueSel = f.children.find((c) => c.name === 'issue');
        data[f.alias] = { issue: issueSel ? resolveIssueFields(hit.repo, hit.issue, issueSel.children) : resolveIssueFields(hit.repo, hit.issue, []) };
        continue;
      }
      if (f.name === 'createPullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? gqlRepoById(input.repositoryId) : null;
        if (!repo) { data[f.alias] = null; errors.push({ message: 'Repository not found' }); continue; }
        const pull = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (!pull) { data[f.alias] = null; errors.push({ message: 'Head branch does not exist' }); continue; }
        const prSel = f.children.find((c) => c.name === 'pullRequest');
        data[f.alias] = { pullRequest: prSel ? resolvePullFields(repo, pull, prSel.children) : resolvePullFields(repo, pull, []) };
        continue;
      }
      if (f.name === 'mergePullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const hit = typeof input.pullRequestId === 'string' ? gqlPullById(input.pullRequestId) : null;
        if (!hit) { data[f.alias] = null; errors.push({ message: 'Pull request not found' }); continue; }
        if (prConflict(hit.repo, hit.pull)) { data[f.alias] = null; errors.push({ message: 'Merge conflict' }); continue; }
        doMerge(hit.repo, hit.pull);
        const prSel = f.children.find((c) => c.name === 'pullRequest');
        data[f.alias] = { pullRequest: prSel ? resolvePullFields(hit.repo, hit.pull, prSel.children) : resolvePullFields(hit.repo, hit.pull, []) };
        continue;
      }
      if (f.name === 'addComment') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const hit = typeof input.subjectId === 'string' ? gqlIssueById(input.subjectId) : null;
        if (!hit) { data[f.alias] = null; errors.push({ message: 'Subject not found' }); continue; }
        const comment = { id: commentIdCounter++, body: String(input.body ?? ''), seq: hit.issue.comments.length };
        hit.issue.comments.push(comment);
        const edge = f.children.find((c) => c.name === 'commentEdge');
        const node = edge?.children.find((c) => c.name === 'node');
        data[f.alias] = { commentEdge: { node: node ? { id: gid('IssueComment', hit.repo.id, hit.issue.number, comment.id), body: comment.body } : { id: gid('IssueComment', hit.repo.id, hit.issue.number, comment.id), body: comment.body } } };
        continue;
      }
      errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
      data[f.alias] = null;
      continue;
    }
    // query root
    if (f.name === 'viewer') {
      const out: Record<string, unknown> = {};
      for (const c of f.children) {
        if (c.name === 'login') out[c.alias] = VIEWER;
        else if (c.name === 'id') out[c.alias] = gid('User', VIEWER_ID);
        else if (c.name === 'databaseId') out[c.alias] = VIEWER_ID;
        else if (c.name === 'name') out[c.alias] = VIEWER_NAME;
        else if (c.name === 'email') out[c.alias] = VIEWER_EMAIL;
        else errors.push({ message: `Cannot query field "${c.name}" on type "User". Did you mean "name" or "login"?` });
      }
      data[f.alias] = out;
      continue;
    }
    if (f.name === 'repository') {
      const owner = String(f.args.owner ?? ''); const name = String(f.args.name ?? '');
      const repo = getRepo(owner, name);
      data[f.alias] = repo ? resolveRepoFields(repo, f.children) : null;
      continue;
    }
    if (f.name === 'node') {
      const id = String(f.args.id ?? '');
      data[f.alias] = resolveNode(id, f.children);
      continue;
    }
    if (f.name === '__type') {
      const typeName = String(f.args.name ?? '');
      const fields = typeFields(typeName);
      if (!fields && typeName !== 'SearchType') { data[f.alias] = null; continue; }
      const out: Record<string, unknown> = { name: typeName, kind: typeName === 'SearchType' ? 'ENUM' : 'OBJECT' };
      for (const c of f.children) {
        if (c.name === 'name') out[c.alias] = typeName;
        else if (c.name === 'kind') out[c.alias] = typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
        else if (c.name === 'fields') out[c.alias] = (fields ?? []).map((fn) => ({ name: fn, type: { name: fn, kind: 'SCALAR' } }));
        else if (c.name === 'enumValues') out[c.alias] = typeName === 'SearchType' ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'DISCUSSION' }, { name: 'COMMIT' }, { name: 'CODE' }] : null;
        else if (c.name === 'description') out[c.alias] = '';
      }
      data[f.alias] = out;
      continue;
    }
    if (f.name === '__schema') {
      data[f.alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [{ name: 'Repository' }, { name: 'Issue' }, { name: 'PullRequest' }] };
      continue;
    }
    if (f.name === 'search') {
      data[f.alias] = { nodes: [], edges: [], pageInfo: { hasNextPage: false, endCursor: null }, issueCount: 0, repositoryCount: 0, userCount: 0 };
      continue;
    }
    errors.push({ message: `Cannot query field "${f.name}" on type "Query". Did you mean "repository" or "viewer"?` });
    data[f.alias] = null;
  }
  const result: { data?: Record<string, unknown>; errors?: GQLError[] } = {};
  if (errors.length) result.errors = errors;
  result.data = data;
  return result;
}
// ---------------------------------------------------------------- MCP
const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, owner: { type: 'string', description: 'Owner login (defaults to the viewer)' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string', description: 'Repository name' }, name: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, number: { type: 'number' }, merge_method: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpToolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function mcpToolError(msg: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: msg }], isError: true };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER;
  const repoName = typeof args.repo === 'string' && args.repo ? args.repo : typeof args.name === 'string' ? args.name : '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  const resolvedOwner = fullName ? fullName.split('/')[0] : owner;
  const resolvedRepo = fullName ? fullName.split('/')[1] : repoName;
  switch (name) {
    case 'create_repo': {
      const repoName2 = String(args.name ?? args.repo ?? '');
      if (!repoName2) return mcpToolError('Missing required argument: name');
      if (repos.has(`${VIEWER}/${repoName2}`)) return mcpToolError('Repository already exists');
      const repo = createRepoRecord(repoName2, args.private === true, typeof args.description === 'string' ? args.description : '');
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      if (!resolvedRepo) return mcpToolError('Missing required argument: repo');
      const repo = getRepo(resolvedOwner, resolvedRepo);
      if (!repo) return mcpToolError(`Repository not found: ${resolvedOwner}/${resolvedRepo}`);
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      if (!resolvedRepo) return mcpToolError('Missing required argument: repo');
      if (typeof args.title !== 'string' || !args.title) return mcpToolError('Missing required argument: title');
      const repo = getRepo(resolvedOwner, resolvedRepo);
      if (!repo) return mcpToolError(`Repository not found: ${resolvedOwner}/${resolvedRepo}`);
      const created = createIssueRecord(repo, args.title, typeof args.body === 'string' ? args.body : '', Array.isArray(args.labels) ? args.labels.map(String) : []);
      if ('error' in created) return mcpToolError(created.error);
      return mcpToolResult(issueJson(repo, created));
    }
    case 'list_issues': {
      if (!resolvedRepo) return mcpToolError('Missing required argument: repo');
      const repo = getRepo(resolvedOwner, resolvedRepo);
      if (!repo) return mcpToolError(`Repository not found: ${resolvedOwner}/${resolvedRepo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return mcpToolResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      if (!resolvedRepo) return mcpToolError('Missing required argument: repo');
      const repo = getRepo(resolvedOwner, resolvedRepo);
      if (!repo) return mcpToolError(`Repository not found: ${resolvedOwner}/${resolvedRepo}`);
      const pull = createPullRecord(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? 'main'));
      if (!pull) return mcpToolError('Head branch does not exist');
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      if (!resolvedRepo) return mcpToolError('Missing required argument: repo');
      const repo = getRepo(resolvedOwner, resolvedRepo);
      if (!repo) return mcpToolError(`Repository not found: ${resolvedOwner}/${resolvedRepo}`);
      const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return mcpToolError('Pull request not found');
      if (pull.merged) return mcpToolResult({ sha: pull.merge_commit_sha, merged: true, message: 'Pull request successfully merged' });
      if (prConflict(repo, pull)) return mcpToolError('Merge conflict');
      const merged = doMerge(repo, pull);
      return mcpToolResult({ sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}
function mcpHandle(body: unknown, res: ServerResponse): void {
  const isObj = body !== null && typeof body === 'object' && !Array.isArray(body);
  const reqObj = isObj ? (body as Record<string, unknown>) : {};
  const id = isObj ? reqObj.id : null;
  const method = isObj ? String(reqObj.method ?? '') : '';
  const params = isObj && reqObj.params !== null && typeof reqObj.params === 'object' ? reqObj.params as Record<string, unknown> : {};
  const sendRpc = (status: number, payload: Record<string, unknown>): void => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'mcp-session-id': 'session-1' });
    res.end(text);
  };
  const result = (value: Record<string, unknown>): void => sendRpc(200, { jsonrpc: '2.0', id: id ?? null, result: value });
  const error = (code: number, message: string, status = 200): void => sendRpc(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!isObj || method === '') {
    // notification without id
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (method === 'server/discover') {
    result({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: '1.0.0' }, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    result({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: '1.0.0' }, 'io.modelcontextprotocol/protocolVersion': offered },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (method === 'ping') { result({}); return; }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS, nextCursor: undefined });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { error(-32602, `Unknown tool: ${name}`); return; }
    const required = (tool.inputSchema.required as string[] | undefined) ?? [];
    for (const r of required) {
      if (args[r] === undefined || args[r] === null || args[r] === '') {
        result(mcpToolError(`Missing required argument: ${r}`));
        return;
      }
    }
    result(mcpCallTool(name, args));
    return;
  }
  if (method === 'prompts/list') { result({ prompts: [] }); return; }
  if (method === 'resources/list') { result({ resources: [] }); return; }
  error(-32601, `Method not found: ${method}`);
}
// ---------------------------------------------------------------- server
export function createApp(): Server {
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = pathOf(req);
    try {
      // health
      if (path === '/healthz' && method === 'GET') {
        res.writeHead(200, { 'content-type': JSON_TYPE, 'x-github-request-id': reqId() });
        res.end('{"ok":true}\n');
        return;
      }
      // git smart HTTP (no auth)
      if (await handleGit(req, res, path, method)) return;
      // graphql
      if (path === '/api/graphql' && method === 'POST') {
        if (!authed(req)) { unauthorized(res); return; }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] }); return; }
        const docs = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
        const out = docs.map((doc) => {
          const d = doc !== null && typeof doc === 'object' ? doc as Record<string, unknown> : {};
          const query = typeof d.query === 'string' ? d.query : '';
          const variables = d.variables !== null && typeof d.variables === 'object' ? d.variables as Record<string, unknown> : {};
          return executeGQL(query, variables, typeof d.operationName === 'string' ? d.operationName : undefined);
        });
        sendJson(res, 200, Array.isArray(parsed.value) ? out : out[0]);
        return;
      }
      // mcp
      if (path === '/mcp') {
        if (method === 'DELETE') { res.writeHead(204); res.end(); return; }
        if (method === 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } })); return; }
        if (method === 'POST') {
          if (!authed(req)) {
            const text = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
            res.end(text);
            return;
          }
          const raw = await readBody(req);
          if (raw.length === 0) { mcpHandle({}, res); return; }
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            const text = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
            res.end(text);
            return;
          }
          mcpHandle(parsed.value, res);
          return;
        }
      }
      // REST
      if (await handleRest(req, res, path, method)) return;
      // fallback
      if (path.startsWith('/api/v3')) { notFound(res); return; }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    } catch {
      if (!res.headersSent) {
        try { sendJson(res, 500, { message: 'Internal Server Error' }); } catch { /* ignore */ }
      }
    }
  });
  return server;
}
export default createApp;
