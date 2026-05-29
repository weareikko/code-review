#!/usr/bin/env node
/**
 * Snapshot a GitLab merge request into eval fixture files.
 *
 *   node scripts/snapshot-mr.mjs \
 *     --project group/repo --mr 123 --name my-fixture \
 *     [--gitlab-url https://gitlab.com] [--token $GITLAB_TOKEN]
 *
 * Writes to tests/evals/fixtures/<name>.{diff,commitlog,prior-threads.json}
 * and prints a copy-pastable describeEval stub. Lowers the friction for
 * reproducing a real production review failure locally and adding it as a
 * golden case before fixing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, '..', 'tests', 'evals', 'fixtures');

const FINGERPRINT_MARKER_RE =
  /<!--\s*(?:gitlab-review|pi-reviewer):fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/i;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function die(msg) {
  console.error(`snapshot-mr: ${msg}`);
  process.exit(1);
}

async function pageThroughApi(client, path) {
  const out = [];
  let page = 1;
  // 100 is the GitLab cap for most list endpoints.
  while (true) {
    const url = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const res = await client.get(url);
    if (!Array.isArray(res)) {
      throw new Error(`Expected array from ${url}, got ${typeof res}`);
    }
    out.push(...res);
    if (res.length < 100) break;
    page += 1;
    if (page > 50) throw new Error(`Pagination overflow on ${path}`);
  }
  return out;
}

function makeClient({ gitlabUrl, token, authHeader }) {
  const base = gitlabUrl.replace(/\/$/, '');
  const headers = { [authHeader]: token, Accept: 'application/json' };
  return {
    get: async (path) => {
      const url = `${base}/api/v4${path}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 300)}`);
      }
      return res.json();
    },
  };
}

// Assemble GitLab's per-file diff objects back into a unified diff that the
// reviewer harness can ingest. GitLab returns the patch text in `diff` but
// strips the `diff --git` / `index` / `--- a/X` / `+++ b/Y` headers.
function reassembleDiff(diffs) {
  const sections = [];
  for (const d of diffs) {
    const oldPath = d.old_path ?? d.new_path;
    const newPath = d.new_path ?? d.old_path;
    if (!oldPath || !newPath) continue;
    const header = [`diff --git a/${oldPath} b/${newPath}`];
    if (d.new_file) header.push('new file mode 100644');
    else if (d.deleted_file) header.push('deleted file mode 100644');
    else if (d.renamed_file) header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
    const fromPath = d.new_file ? '/dev/null' : `a/${oldPath}`;
    const toPath = d.deleted_file ? '/dev/null' : `b/${newPath}`;
    header.push(`--- ${fromPath}`, `+++ ${toPath}`);
    const patch = (d.diff ?? '').replace(/\r\n/g, '\n');
    sections.push(`${header.join('\n')}\n${patch}${patch.endsWith('\n') ? '' : '\n'}`);
  }
  return sections.join('');
}

function formatCommitLog(commits) {
  // Oldest first, mirroring getMergeCommitLog in src/git.ts. Skip pure merge
  // commits (their messages add noise and aren't useful as intent signal).
  const ordered = [...commits].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const blocks = [];
  for (const c of ordered) {
    if ((c.parent_ids ?? []).length > 1) continue;
    const sha = c.id ?? c.short_id;
    const author = `${c.author_name ?? ''} <${c.author_email ?? ''}>`;
    const date = c.created_at;
    const message = (c.message ?? c.title ?? '').replace(/\r\n/g, '\n').trim();
    const indented = message
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    blocks.push(`commit ${sha}\nAuthor: ${author}\nDate:   ${date}\n\n${indented}`);
  }
  return blocks.join('\n\n');
}

function isBotNote(note) {
  return FINGERPRINT_MARKER_RE.test(note.body ?? '');
}

function normalizeBody(body) {
  return String(body ?? '')
    .replace(FINGERPRINT_MARKER_RE, '')
    .replace(/^(?:🔴|🟡|🔵)\s*/gmu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChangedFiles(diff) {
  const files = new Set();
  for (const line of diff.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match && match[1] !== '/dev/null') files.add(match[1]);
  }
  return files;
}

function positionLine(note) {
  return note.position?.new_line ?? note.position?.old_line ?? null;
}

function positionFile(note) {
  return note.position?.new_path ?? note.position?.old_path ?? null;
}

function extractPriorThreads(discussions, changedFiles) {
  const threads = [];
  for (const discussion of discussions) {
    const notes = discussion.notes ?? [];
    const botIdx = notes.findIndex(isBotNote);
    if (botIdx === -1) continue;
    const botNote = notes[botIdx];
    const file = positionFile(botNote);
    if (!file || !changedFiles.has(file)) continue;
    const replies = notes
      .slice(botIdx + 1)
      .filter((n) => !n.system && (n.body?.trim() ?? ''))
      .filter((n) => !isBotNote(n))
      .map((n) => n.body?.trim() ?? '');
    if (replies.length === 0) continue;
    const resolved = notes.some((n) => n.resolved === true);
    threads.push({
      file,
      line: positionLine(botNote),
      resolved,
      botComment: normalizeBody(botNote.body ?? ''),
      replies,
    });
  }
  return threads;
}

function buildStub(name, hasCommitLog, hasPriorThreads) {
  const lines = [
    `describeEval(`,
    `  '${name} — recording only',`,
    `  {`,
    `    harness: reviewHarness,`,
    `    judges: [HasSevereFindingJudge],`,
    `    judgeThreshold: null,`,
    `    skipIf: missingApiKey,`,
    `  },`,
    `  (it) => {`,
    `    it('snapshot review for ${name}', async ({ run }) => {`,
    `      const diff = await readFile(join(FIXTURES, '${name}.diff'), 'utf8');`,
  ];
  if (hasCommitLog) {
    lines.push(`      const commitLog = await readFile(join(FIXTURES, '${name}.commitlog'), 'utf8');`);
  }
  if (hasPriorThreads) {
    lines.push(
      `      const priorThreads = JSON.parse(`,
      `        await readFile(join(FIXTURES, '${name}.prior-threads.json'), 'utf8'),`,
      `      );`,
    );
  }
  const runArgs = ['diff', 'skills: []'];
  if (hasCommitLog) runArgs.push('commitLog');
  if (hasPriorThreads) runArgs.push('priorThreads');
  lines.push(
    `      const result = await run({ ${runArgs.join(', ')} });`,
    `      expect(result.output).toBeDefined();`,
    `    });`,
    `  },`,
    `);`,
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project;
  const mr = args.mr;
  const name = args.name;
  const gitlabUrl =
    args['gitlab-url'] ?? process.env.GITLAB_URL ?? process.env.CI_SERVER_URL ?? 'https://gitlab.com';
  const token =
    args.token ?? process.env.GITLAB_TOKEN ?? process.env.GITLAB_REVIEW_GITLAB_TOKEN ?? '';
  const authHeader = args['auth-header'] ?? 'PRIVATE-TOKEN';

  if (!project) die('--project is required (e.g. --project group/repo)');
  if (!mr) die('--mr is required (e.g. --mr 123)');
  if (!name) die('--name is required (e.g. --name auth-regression)');
  if (!token) die('token is required (set GITLAB_TOKEN or pass --token)');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) die(`--name must be a safe filename slug, got "${name}"`);

  const client = makeClient({ gitlabUrl, token, authHeader });
  const encodedProject = encodeURIComponent(project);
  const mrPath = `/projects/${encodedProject}/merge_requests/${encodeURIComponent(mr)}`;

  console.log(`Fetching MR ${project}!${mr} from ${gitlabUrl}...`);
  const [diffs, commits, discussions] = await Promise.all([
    pageThroughApi(client, `${mrPath}/diffs`),
    pageThroughApi(client, `${mrPath}/commits`),
    pageThroughApi(client, `${mrPath}/discussions`),
  ]);

  const diff = reassembleDiff(diffs);
  const commitLog = formatCommitLog(commits);
  const changedFiles = extractChangedFiles(diff);
  const priorThreads = extractPriorThreads(discussions, changedFiles);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const diffPath = join(FIXTURES_DIR, `${name}.diff`);
  const commitLogPath = join(FIXTURES_DIR, `${name}.commitlog`);
  const priorThreadsPath = join(FIXTURES_DIR, `${name}.prior-threads.json`);

  await writeFile(diffPath, diff, 'utf8');
  console.log(`  wrote ${diffPath} (${diff.length} bytes, ${changedFiles.size} files)`);

  if (commitLog) {
    await writeFile(commitLogPath, `${commitLog}\n`, 'utf8');
    console.log(`  wrote ${commitLogPath} (${commits.length} commits)`);
  }

  if (priorThreads.length > 0) {
    await writeFile(priorThreadsPath, `${JSON.stringify(priorThreads, null, 2)}\n`, 'utf8');
    console.log(`  wrote ${priorThreadsPath} (${priorThreads.length} prior thread(s))`);
  } else {
    console.log(`  no prior bot threads with developer replies — skipping prior-threads.json`);
  }

  console.log('\nSuggested describeEval stub (paste into tests/evals/review.eval.ts):\n');
  console.log(buildStub(name, Boolean(commitLog), priorThreads.length > 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
