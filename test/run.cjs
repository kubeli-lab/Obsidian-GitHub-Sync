const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
// End-to-end simulation of several people syncing one remote. Runs the real plugin
// code (main.ts) with a stubbed `obsidian` module, one process per person.
// Usage: npm test   (QUICK=1 npm test skips the slowest stress scenario)
const TMP = path.join(os.tmpdir(), 'vault-digest-test');
const ROOT = path.join(TMP, 'work');
const ACTOR = path.join(TMP, 'actor.cjs');
fs.mkdirSync(TMP, { recursive: true });
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'actor.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: ACTOR,
  alias: { obsidian: path.join(__dirname, 'obsidian-stub.ts') }, logLevel: 'error',
});
const sh = (cwd, cmd) => cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const sh0 = (cwd, cmd) => { try { return sh(cwd, cmd); } catch (e) { return 'ERR:' + (e.stderr || e.message); } };
const parse = (out) => { const m = /__NOTICES__(.*)/.exec(out); return m ? JSON.parse(m[1]) : ['NO OUTPUT: ' + out.slice(-300)]; };
function runActor(dir, remote, cmd = 'sync', interactive = 'false', branch = 'main') {
  const r = cp.spawnSync('node', [ACTOR, dir, remote, cmd, interactive], { encoding: 'utf8', env: { ...process.env, BRANCH: branch } });
  return parse(r.stdout + (r.stderr || ''));
}
function runActorAsync(dir, remote, cmd = 'sync') {
  return new Promise((res) => { let out = ''; const c = cp.spawn('node', [ACTOR, dir, remote, cmd, 'false']); c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d); c.on('close', () => res(parse(out))); });
}
let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
let n = 0;
function fixture(files = { 'x.md': 'l1\nl2\nl3\nl4\nl5\n', 'y.md': 'y\n', 'note.md': 'See [[Alpha]] #proj\n- [ ] task\n' }) {
  const d = path.join(ROOT, 's' + (++n)); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  const remote = path.join(d, 'remote.git'); sh(d, 'git init -q --bare -b main remote.git');
  const seed = path.join(d, 'seed'); sh(d, `git clone -q ${remote} seed 2>/dev/null`);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(seed, f), c);
  sh(seed, 'git -c user.name=seed -c user.email=s@s add -A && git -c user.name=seed -c user.email=s@s commit -qm init && git push -q origin HEAD:main');
  const mk = (name) => { const v = path.join(d, name); sh(d, `git clone -q ${remote} ${name} 2>/dev/null`); sh(v, `git config user.name ${name} && git config user.email ${name}@t`); return v; };
  return { remote, A: mk('A'), B: mk('B'), d };
}
const w = (dir, f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
const r = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const remoteShow = (remote, f) => sh0(remote, `git show main:${f}`);
const merges = (remote) => parseInt(sh(remote, 'git rev-list --merges --count main'));
const stashes = (dir) => sh(dir, 'git stash list');
const has = (notices, s) => notices.some(m => m.includes(s));
fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });

(async () => {
console.log('D1 digest: links, tags (inline frontmatter and body), tasks, file names with spaces');
{ const { buildSync } = require('esbuild'); const out = path.join(TMP, 'digest.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '..', 'digest.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const d = require(out);
  const diff = ['diff --git a/n.md b/n.md', '--- a/n.md', '+++ b/n.md', '@@ -2,4 +2,4 @@', '-See [[Alpha]] and [[Beta|b]] #proj', '-- [ ] todo one', '-tags: [a, b]', '-moved [[Same]]', '+See [[Alpha]] and [[Gamma]] #proj #idea', '+- [x] todo one', '+tags: [a, "c"]', '+moved [[Same]] again',
    'diff --git a/with space é.md b/with space é.md', 'new file mode 100644', '--- /dev/null', '+++ b/with space é.md\t', '@@ -0,0 +1 @@', '+new [[Delta]] #z', 'diff --git a/code.ts b/code.ts', '--- a/code.ts', '+++ b/code.ts', '@@ -1 +1 @@', '-x [[Nope]]', '+y [[Nope2]]'].join('\n') + '\n';
  const r = d.analyzeDiff(diff);
  check('links: +Gamma +Delta -Beta, same-note move ignored, non-markdown ignored', JSON.stringify(r.linksAdded.sort()) === '["Delta","Gamma"]' && JSON.stringify(r.linksRemoved) === '["Beta"]', JSON.stringify(r));
  check('tags: +idea +z +c, -b', JSON.stringify(r.tagsAdded.sort()) === '["c","idea","z"]' && JSON.stringify(r.tagsRemoved) === '["b"]', JSON.stringify(r));
  check('task toggled counts as done, not as new', r.tasksDone === 1 && r.tasksNew === 0, JSON.stringify(r));
  const sub = d.fitSubject('vault: sync from my-laptop', ['1 added, 3 modified +40 -8', '+3 links', '+2 tags', '5 tasks done']);
  check('subject fits 100 characters', sub.length <= 100 && sub.startsWith('vault: sync from my-laptop'), sub);
  const body = d.fitBody(Array.from({ length: 5000 }, (_, i) => 'M notes/folder/' + 'x'.repeat(40) + i + '.md (+1 -1)'));
  check('body stays under 1500 characters and ends with a count', body.join('\n').length <= 1500 && /^\.\.\. and \d+ more$/.test(body[body.length - 1]), String(body.join('\n').length)); }

console.log('S1 edits on different files, both uncommitted, new files on both sides');
{ const f = fixture(); w(f.A, 'a.md', 'from A\n'); w(f.B, 'b.md', 'from B\n');
  const na = runActor(f.A, f.remote); const nb = runActor(f.B, f.remote); const na2 = runActor(f.A, f.remote);
  check('A first sync succeeds', has(na, 'github sync successful'), JSON.stringify(na));
  check('B sync succeeds (stash, rebase, pop, commit, push)', has(nb, 'github sync successful'), JSON.stringify(nb));
  check('remote has both files', remoteShow(f.remote, 'a.md') === 'from A' && remoteShow(f.remote, 'b.md') === 'from B');
  check('A received b.md', fs.existsSync(path.join(f.A, 'b.md')));
  check('no merge commits (linear)', merges(f.remote) === 0);
  check('no stash left', stashes(f.B) === '' && stashes(f.A) === '');
  check('B commit message is a vault digest message', /^vault: sync from /.test(sh(f.remote, 'git log -1 --format=%s main')), sh(f.remote, 'git log -1 --format=%s main'));
  check('A pulled recap lists b.md', has(na2, 'b.md'), JSON.stringify(na2)); }

console.log('S2 same file, different hunks (auto-merge through stash pop)');
{ const f = fixture(); w(f.A, 'x.md', 'A1\nl2\nl3\nl4\nl5\n'); w(f.B, 'x.md', 'l1\nl2\nl3\nl4\nB5\n');
  runActor(f.A, f.remote); const nb = runActor(f.B, f.remote);
  check('B sync succeeds', has(nb, 'github sync successful'), JSON.stringify(nb));
  check('remote has both edits', remoteShow(f.remote, 'x.md') === 'A1\nl2\nl3\nl4\nB5', remoteShow(f.remote, 'x.md')); 
  check('no markers', !remoteShow(f.remote, 'x.md').includes('<<<<<<<')); }

console.log('S3 same line conflict via stash pop: suspend, stay suspended, resume after resolution');
{ const f = fixture(); w(f.A, 'x.md', 'l1\nA-LINE\nl3\nl4\nl5\n'); w(f.B, 'x.md', 'l1\nB-LINE\nl3\nl4\nl5\n');
  runActor(f.A, f.remote); const headRemote = sh(f.remote, 'git rev-parse main');
  const nb = runActor(f.B, f.remote);
  check('B notice: conflicts + suspended', has(nb, 'Merge conflicts in') && has(nb, 'suspended'), JSON.stringify(nb));
  check('nothing pushed by B', sh(f.remote, 'git rev-parse main') === headRemote);
  check('B file has markers', r(f.B, 'x.md').includes('<<<<<<<') && r(f.B, 'x.md').includes('A-LINE') && r(f.B, 'x.md').includes('B-LINE'));
  check('B stash kept', stashes(f.B).includes('vault-digest autostash'));
  const headB = sh(f.B, 'git rev-parse HEAD');
  const nb2 = runActor(f.B, f.remote);
  check('second sync stays suspended, no commit', has(nb2, 'suspended') && sh(f.B, 'git rev-parse HEAD') === headB && sh(f.remote, 'git rev-parse main') === headRemote, JSON.stringify(nb2));
  w(f.B, 'x.md', 'l1\nA-LINE and B-LINE\nl3\nl4\nl5\n');
  const nb3 = runActor(f.B, f.remote);
  check('after resolution: sync succeeds', has(nb3, 'github sync successful'), JSON.stringify(nb3));
  check('remote has the resolution', remoteShow(f.remote, 'x.md').includes('A-LINE and B-LINE'));
  check('stash dropped automatically', stashes(f.B) === '', stashes(f.B));
  runActor(f.A, f.remote); check('A receives the resolution', r(f.A, 'x.md').includes('A-LINE and B-LINE'));
  check('no merge commits', merges(f.remote) === 0); }

console.log('S4 same conflict resolved with git mergetool (fake tool)');
{ const f = fixture(); w(f.A, 'x.md', 'l1\nA-LINE\nl3\nl4\nl5\n'); w(f.B, 'x.md', 'l1\nB-LINE\nl3\nl4\nl5\n');
  runActor(f.A, f.remote); runActor(f.B, f.remote);
  sh(f.B, `git config merge.tool fake && git config mergetool.fake.cmd 'printf "l1\\nmerged by tool\\nl3\\nl4\\nl5\\n" > "$MERGED"' && git config mergetool.fake.trustExitCode true`);
  const nr = runActor(f.B, f.remote, 'resolve');
  check('resolve flow pushes', has(nr, 'Conflicts resolved') && has(nr, 'github sync successful'), JSON.stringify(nr));
  check('remote has tool resolution', remoteShow(f.remote, 'x.md').includes('merged by tool'));
  check('no .orig leftovers', !fs.existsSync(path.join(f.B, 'x.md.orig')));
  check('stash dropped', stashes(f.B) === ''); }

console.log('S5 unpushed local commit conflicts with remote (rebase fails, merge fallback)');
{ const f = fixture(); w(f.A, 'x.md', 'l1\nA-LINE\nl3\nl4\nl5\n'); runActor(f.A, f.remote);
  w(f.B, 'x.md', 'l1\nB-LINE\nl3\nl4\nl5\n'); sh(f.B, 'git add -A && git commit -qm "local unpushed"');
  const nb = runActor(f.B, f.remote);
  check('conflict reported + suspended', has(nb, 'Merge conflicts in') && has(nb, 'suspended'), JSON.stringify(nb));
  check('markers present', r(f.B, 'x.md').includes('<<<<<<<'));
  w(f.B, 'x.md', 'l1\nboth\nl3\nl4\nl5\n');
  const nb2 = runActor(f.B, f.remote);
  check('after resolution sync succeeds and pushes', has(nb2, 'github sync successful') && remoteShow(f.remote, 'x.md').includes('both'), JSON.stringify(nb2)); }

console.log('S6 unpushed local commit, clean tree, remote unchanged (e.g. earlier push failed)');
{ const f = fixture(); w(f.B, 'late.md', 'late\n'); sh(f.B, 'git add -A && git commit -qm "local unpushed"');
  const nb = runActor(f.B, f.remote);
  check('unpushed commit gets pushed', remoteShow(f.remote, 'late.md') === 'late', JSON.stringify(nb)); }

console.log('S7 A deletes a file, B modifies it');
{ const f = fixture(); sh(f.A, 'rm y.md'); runActor(f.A, f.remote); w(f.B, 'y.md', 'B edited\n');
  const nb = runActor(f.B, f.remote);
  console.log('    notices:', JSON.stringify(nb));
  console.log('    remote y.md:', remoteShow(f.remote, 'y.md').slice(0, 40), '| B status:', sh0(f.B, 'git status --short').replace(/\n/g, ' ; '));
  check('B edit is not lost', fs.existsSync(path.join(f.B, 'y.md')) && r(f.B, 'y.md').includes('B edited'));
  check('conflict reported (modify/delete) and sync suspended', has(nb, 'deleted on one side') && has(nb, 'suspended'), JSON.stringify(nb));
  const nb2 = runActor(f.B, f.remote, 'sync', 'true');
  check('another sync stays suspended until a choice is made', has(nb2, 'suspended') && remoteShow(f.remote, 'y.md').startsWith('ERR'), JSON.stringify(nb2));
  const nk = runActor(f.B, f.remote, 'keep:y.md');
  check('Keep file: sync resumes and pushes the edited file', has(nk, 'github sync successful') && remoteShow(f.remote, 'y.md') === 'B edited', JSON.stringify(nk));
  check('stash dropped after the decision', stashes(f.B) === '', stashes(f.B)); }

console.log('S7b A deletes a file, B modifies it, B accepts the deletion');
{ const f = fixture(); sh(f.A, 'rm y.md'); runActor(f.A, f.remote); w(f.B, 'y.md', 'B edited\n'); w(f.B, 'other.md', 'other\n');
  runActor(f.B, f.remote);
  const nd = runActor(f.B, f.remote, 'delete:y.md');
  check('Delete file: sync resumes, file stays deleted on the remote', has(nd, 'github sync successful') && remoteShow(f.remote, 'y.md').startsWith('ERR'), JSON.stringify(nd));
  check('B other pending file is pushed too', remoteShow(f.remote, 'other.md') === 'other');
  check('file gone locally, no stash', !fs.existsSync(path.join(f.B, 'y.md')) && stashes(f.B) === ''); }

console.log('S7c repeated scheduled syncs during a conflict: one notice per conflict set');
{ const f = fixture(); w(f.A, 'x.md', 'l1\nA-LINE\nl3\nl4\nl5\n'); w(f.B, 'x.md', 'l1\nB-LINE\nl3\nl4\nl5\n');
  runActor(f.A, f.remote);
  const first = runActor(f.B, f.remote);
  check('conflict reported at first sync', has(first, 'Merge conflicts in'));
  // one plugin instance, several scheduled (non-interactive) syncs in a row
  const rep = runActor(f.B, f.remote, 'repeat');
  check('repeated scheduled syncs: only 1 notice (the first in this process), manual sync notifies again', rep.filter(m => m.includes('Merge conflicts in')).length === 2, JSON.stringify(rep.map(m => m.slice(0, 40)))); }

console.log('S8 simultaneous syncs (two processes at once), different files');
{ const f = fixture(); w(f.A, 'a.md', 'A\n'); w(f.B, 'b.md', 'B\n');
  const [na, nb] = await Promise.all([runActorAsync(f.A, f.remote), runActorAsync(f.B, f.remote)]);
  console.log('    A:', JSON.stringify(na).slice(0, 160)); console.log('    B:', JSON.stringify(nb).slice(0, 160));
  runActor(f.A, f.remote); runActor(f.B, f.remote); runActor(f.A, f.remote);
  check('converged: remote has both', remoteShow(f.remote, 'a.md') === 'A' && remoteShow(f.remote, 'b.md') === 'B');
  check('A and B identical to remote', sh(f.A, 'git rev-parse HEAD') === sh(f.remote, 'git rev-parse main') && sh(f.B, 'git rev-parse HEAD') === sh(f.remote, 'git rev-parse main'));
  check('no stash, no merge commits', stashes(f.A) === '' && stashes(f.B) === '' && merges(f.remote) === 0); }

console.log('S9 stress: 6 rounds, both edit own files and one shared file at different lines, simultaneous syncs');
{ const f = fixture({ 'shared.md': Array.from({ length: 12 }, (_, i) => 'line' + i).join('\n') + '\n' });
  for (let i = 0; i < 6; i++) {
    w(f.A, `a${i}.md`, 'A' + i + '\n'); w(f.B, `b${i}.md`, 'B' + i + '\n');
    const sa = r(f.A, 'shared.md').split('\n'); sa[0] = 'A-top-' + i; w(f.A, 'shared.md', sa.join('\n'));
    const sb = r(f.B, 'shared.md').split('\n'); sb[10] = 'B-bottom-' + i; w(f.B, 'shared.md', sb.join('\n'));
    await Promise.all([runActorAsync(f.A, f.remote), runActorAsync(f.B, f.remote)]);
    runActor(f.A, f.remote); runActor(f.B, f.remote);
  }
  runActor(f.A, f.remote); runActor(f.B, f.remote);
  const ha = sh(f.A, 'git rev-parse HEAD'), hb = sh(f.B, 'git rev-parse HEAD'), hr = sh(f.remote, 'git rev-parse main');
  let allFiles = true; for (let i = 0; i < 6; i++) allFiles = allFiles && remoteShow(f.remote, `a${i}.md`) === 'A' + i && remoteShow(f.remote, `b${i}.md`) === 'B' + i;
  check('no lost files', allFiles);
  check('A, B and remote converge', ha === hr && hb === hr, `${ha.slice(0,7)} ${hb.slice(0,7)} ${hr.slice(0,7)}`);
  check('shared.md has final edits from both', remoteShow(f.remote, 'shared.md').includes('A-top-5') && remoteShow(f.remote, 'shared.md').includes('B-bottom-5'));
  check('no conflict markers anywhere', !sh0(f.remote, 'git grep -l "^<<<<<<< " main').startsWith('main:'));
  check('no stash', stashes(f.A) === '' && stashes(f.B) === ''); }

console.log('S11 custom main branch (trunk), mismatch guard and invalid name');
{ const d = path.join(ROOT, 'trunk'); fs.mkdirSync(d, { recursive: true }); const remote = path.join(d, 'remote.git'); sh(d, 'git init -q --bare -b trunk remote.git');
  sh(d, `git clone -q ${remote} seed 2>/dev/null`); fs.writeFileSync(path.join(d, 'seed', 'x.md'), 'one\n');
  sh(path.join(d, 'seed'), 'git checkout -q -b trunk 2>/dev/null; git -c user.name=s -c user.email=s@s add -A && git -c user.name=s -c user.email=s@s commit -qm init && git push -q origin trunk');
  const mk = (n) => { sh(d, `git clone -q ${remote} ${n} 2>/dev/null`); sh(path.join(d, n), `git config user.name ${n} && git config user.email ${n}@t`); return path.join(d, n); };
  const A = mk('A'), B = mk('B');
  check('clone is on trunk', sh(B, 'git branch --show-current') === 'trunk');
  w(A, 'a.md', 'A\n'); w(B, 'b.md', 'B\n');
  const na = runActor(A, remote, 'sync', 'false', 'trunk'); const nb = runActor(B, remote, 'sync', 'false', 'trunk');
  check('both syncs succeed on trunk', has(na, 'github sync successful') && has(nb, 'github sync successful'), JSON.stringify([na, nb]));
  check('remote trunk has both files, linear', sh0(remote, 'git show trunk:a.md') === 'A' && sh0(remote, 'git show trunk:b.md') === 'B' && sh(remote, 'git rev-list --merges --count trunk') === '0');
  w(B, 'c.md', 'C\n'); const head = sh(remote, 'git rev-parse trunk');
  const nm = runActor(B, remote, 'sync', 'false', 'main');
  check('mismatch (setting main, vault on trunk): error, nothing pushed', has(nm, 'main branch setting') && sh(remote, 'git rev-parse trunk') === head, JSON.stringify(nm));
  const ni = runActor(B, remote, 'sync', 'false', '--force');
  check('invalid branch name rejected', has(ni, 'invalid main branch name') && sh(remote, 'git rev-parse trunk') === head, JSON.stringify(ni));
  const nd = runActor(B, remote, 'sync', 'false', 'trunk');
  check('B pending file synced once the setting matches', sh0(remote, 'git show trunk:c.md') === 'C', JSON.stringify(nd)); }

console.log('S12 two syncs started at once inside one Obsidian (ribbon click during scheduled sync)');
{ const f = fixture(); w(f.A, 'a.md', 'A\n'); w(f.B, 'b.md', 'B\n'); runActor(f.A, f.remote);
  const n = runActor(f.B, f.remote, 'double');
  check('only one sync ran, the others were refused', n.filter(m => m.includes('github sync successful')).length === 1 && n.filter(m => m.includes('already running')).length === 2, JSON.stringify(n));
  check('exactly one commit from B, remote has both, linear', remoteShow(f.remote, 'b.md') === 'B' && remoteShow(f.remote, 'a.md') === 'A' && merges(f.remote) === 0 && sh(f.remote, 'git rev-list --count main') === '3', sh(f.remote, 'git log --oneline main'));
  check('no stash', stashes(f.B) === ''); }

console.log('S13 offline vs invalid remote');
{ const f = fixture(); w(f.B, 'b.md', 'B\n');
  const off = runActor(f.B, 'http://127.0.0.1:1/none.git');
  check('offline: short warning, no "Invalid remote URL"', has(off, 'remote unreachable') && !has(off, 'Invalid remote'), JSON.stringify(off));
  check('offline: local file untouched, nothing committed', fs.existsSync(path.join(f.B, 'b.md')) && sh(f.B, 'git status --short').includes('b.md'));
  const bad = runActor(f.B, path.join(f.d, 'does-not-exist.git'));
  check('invalid remote: explicit error', has(bad, 'cannot fetch from the remote') && !has(bad, 'unreachable'), JSON.stringify(bad));
  const ok = runActor(f.B, f.remote);
  check('back online: sync succeeds', has(ok, 'github sync successful') && remoteShow(f.remote, 'b.md') === 'B', JSON.stringify(ok)); }

if (!process.env.QUICK) {
console.log('S14 four people, five rounds, all syncing at the same moment (own files + one shared file, distinct lines)');
{ const f = fixture({ 'shared.md': Array.from({ length: 20 }, (_, i) => 'line' + i).join('\n') + '\n' });
  const names = ['A', 'B', 'C', 'D']; const dirs = { A: f.A, B: f.B };
  for (const n of ['C', 'D']) { sh(f.d, `git clone -q ${f.remote} ${n} 2>/dev/null`); dirs[n] = path.join(f.d, n); sh(dirs[n], `git config user.name ${n} && git config user.email ${n}@t`); }
  let firstPassErrors = 0, conflictsSeen = 0;
  for (let round = 0; round < 5; round++) {
    names.forEach((n, k) => { w(dirs[n], `${n}${round}.md`, `${n}-${round}\n`); const L = r(dirs[n], 'shared.md').split('\n'); L[k * 5] = `${n}-edit-${round}`; w(dirs[n], 'shared.md', L.join('\n')); });
    const res = await Promise.all(names.map(n => runActorAsync(dirs[n], f.remote)));
    res.forEach(nt => { if (nt.some(m => /rejected|failed to push|CRASH|ERROR|fatal/i.test(m))) { firstPassErrors++; if (process.env.SHOW) console.log('      ERRNOTICE', JSON.stringify(nt).slice(0, 400)); } if (nt.some(m => m.includes('Merge conflicts'))) conflictsSeen++; });
    for (let pass = 0; pass < 3; pass++) for (const n of names) runActor(dirs[n], f.remote);
  }
  const hr = sh(f.remote, 'git rev-parse main'); const heads = names.map(n => sh(dirs[n], 'git rev-parse HEAD'));
  console.log(`    concurrent syncs ending in an error notice: ${firstPassErrors}, conflicts reported: ${conflictsSeen}`);
  let all = true; for (let round = 0; round < 5; round++) for (const n of names) all = all && remoteShow(f.remote, `${n}${round}.md`) === `${n}-${round}`;
  check('no lost file (20 files)', all);
  check('all four converge to the remote commit', heads.every(h => h === hr), heads.map(h => h.slice(0, 7)).join(' ') + ' / ' + hr.slice(0, 7));
  const sh_ = remoteShow(f.remote, 'shared.md');
  check('shared.md has the last edit of each person', names.every((n, k) => sh_.split('\n')[k * 5] === `${n}-edit-4`), sh_.split('\n').filter((_, i) => i % 5 === 0).join(' '));
  check('no conflict markers, no stash, linear history', !sh0(f.remote, 'git grep -l "^<<<<<<< " main').startsWith('main:') && names.every(n => stashes(dirs[n]) === '') && merges(f.remote) === 0);
  check('every commit has a digest message', sh(f.remote, 'git log --format=%s main').split('\n').filter(l => l !== 'init').every(l => l.startsWith('vault: sync from')), sh(f.remote, 'git log --format=%s main | head -3')); }
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed` + (fail ? ' -> ' + failures.join(' | ') : ''));
process.exit(fail ? 1 : 0);
})();
