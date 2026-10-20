/**
 * Deterministic synthetic-review generator for the input-mode comparison eval.
 *
 * Hand-authoring 120-250k-char multi-file fixtures with known bug locations is
 * impractical and drifts from its ground truth. Instead we assemble large
 * multi-file changes from a small library of realistic bug/filler snippets,
 * tracking the exact new-side line of every planted bug so a location scorer can
 * compute real per-bug recall (not the coarse "any severe finding" proxy).
 *
 * Everything here is deterministic: no randomness, no clock. Given the same
 * spec, the same diff + ground truth come out, so eval runs are reproducible and
 * cacheable. The change is modelled as all-new files (base = empty tree), so a
 * file's content line number equals its new-side diff line number — matching is
 * exact up to the scorer's tolerance.
 *
 * Bug files are deliberately SMALL and filler files LARGE: the reviewer's
 * rank-before-drop sort spends budget on the biggest/most-changed files first,
 * so small bug files are exactly what gets dropped or under-read. That is the
 * behaviour the input-mode comparison is meant to expose.
 */

export type Severity = 'critical' | 'warn';

export type BugKind =
  | 'sql-injection'
  | 'missing-await-loop'
  | 'unhandled-null'
  | 'hardcoded-secret'
  | 'off-by-one'
  | 'missing-authz'
  | 'shared-mutable-race';

export interface PlantedBug {
  id: string;
  kind: BugKind;
  /** Diff path (new-side) the bug lives on. */
  file: string;
  /** 1-based new-side line of the bug's core statement. */
  line: number;
  severity: Severity;
  description: string;
  /** Lowercased substrings any of which, in a finding body, corroborates a match. */
  keywords: string[];
}

export interface SyntheticFile {
  path: string;
  content: string;
  hasBug: boolean;
}

export interface SyntheticCommit {
  message: string;
  /** Paths introduced by this commit, in order. */
  files: string[];
}

export interface SyntheticReview {
  files: SyntheticFile[];
  /** Full unified diff (all files added vs an empty base). */
  diff: string;
  /** Per-commit partition of the files, for Mode C / .patch consumption. */
  commits: SyntheticCommit[];
  groundTruth: PlantedBug[];
  totalChars: number;
}

export interface SyntheticSpec {
  /** Number of bug-free filler files. */
  fillerFiles: number;
  /** Approximate body lines per filler file (drives total size). */
  fillerLinesPerFile: number;
  /** One bug file is emitted per entry; its kind selects the planted defect. */
  bugs: BugKind[];
  /** Number of commits to partition the files across (>=1). */
  commits?: number;
}

interface Snippet {
  lines: string[];
  /** 0-based offset within `lines` of the bug's core statement (bug snippets only). */
  bugOffset?: number;
  meta?: { kind: BugKind; severity: Severity; description: string; keywords: string[] };
}

// --- Bug snippets ---------------------------------------------------------
// Each is self-contained and detectable from the diff alone. `idx` varies
// identifiers so repeated kinds don't collapse into byte-identical code.

function bugSnippet(kind: BugKind, idx: number): Snippet {
  const n = idx;
  switch (kind) {
    case 'sql-injection':
      return {
        lines: [
          `export async function findUser${n}(db: Db, email: string) {`,
          '  // Look up a user by email for the login flow.',
          `  const query = "SELECT * FROM users WHERE email = '" + email + "'";`,
          '  const rows = await db.raw(query);',
          '  return rows[0] ?? null;',
          '}',
        ],
        bugOffset: 2,
        meta: {
          kind,
          severity: 'critical',
          description: 'User-controlled email concatenated into a raw SQL string (SQL injection).',
          keywords: ['sql', 'injection', 'concatenat', 'parameter', 'raw'],
        },
      };
    case 'missing-await-loop':
      return {
        lines: [
          `export async function flushEvents${n}(sink: Sink, events: Event[]) {`,
          '  // Persist each queued analytics event.',
          '  for (const event of events) {',
          '    sink.persist(event);',
          '  }',
          '  return events.length;',
          '}',
        ],
        bugOffset: 3,
        meta: {
          kind,
          severity: 'warn',
          description:
            'Async sink.persist is not awaited inside the loop; writes race and the count returns before they settle.',
          keywords: ['await', 'async', 'promise', 'race', 'persist'],
        },
      };
    case 'unhandled-null':
      return {
        lines: [
          `export function primaryEmail${n}(users: Map<string, User>, id: string) {`,
          "  // Return the account holder's primary email address.",
          '  const user = users.get(id);',
          '  return user.contacts.primary.email;',
          '}',
        ],
        bugOffset: 3,
        meta: {
          kind,
          severity: 'warn',
          description: 'users.get(id) may be undefined; the chained access throws on a missing id.',
          keywords: ['undefined', 'null', 'optional', 'get', 'throw'],
        },
      };
    case 'hardcoded-secret':
      return {
        lines: [
          `export function stripeClient${n}() {`,
          '  // Build the payments client used at checkout.',
          '  const apiKey = "prod_stripe_secret_key_DO_NOT_COMMIT_0000";',
          '  return new Stripe(apiKey, { apiVersion: "2023-10-16" });',
          '}',
        ],
        bugOffset: 2,
        meta: {
          kind,
          severity: 'critical',
          description: 'A live secret API key is hardcoded in source.',
          keywords: ['secret', 'api key', 'hardcoded', 'credential', 'sk_live'],
        },
      };
    case 'off-by-one':
      return {
        lines: [
          `export function pageSlice${n}<T>(items: T[], page: number, size: number) {`,
          '  // Return one page worth of items.',
          '  const start = page * size;',
          '  const end = start + size + 1;',
          '  return items.slice(start, end);',
          '}',
        ],
        bugOffset: 3,
        meta: {
          kind,
          severity: 'warn',
          description: 'end is start+size+1, so each page leaks one item from the next page.',
          keywords: ['off-by-one', 'boundary', 'slice', 'page', 'overlap'],
        },
      };
    case 'missing-authz':
      return {
        lines: [
          `export async function deleteProject${n}(req: Req, res: Res, projects: ProjectRepo) {`,
          '  // Delete the project identified in the request.',
          '  const id = req.params.id;',
          '  await projects.delete(id);',
          '  res.status(204).end();',
          '}',
        ],
        bugOffset: 3,
        meta: {
          kind,
          severity: 'critical',
          description:
            'The mutating endpoint deletes by id with no ownership/authorization check — any caller can delete any project.',
          keywords: ['authorization', 'authz', 'permission', 'ownership', 'access control'],
        },
      };
    case 'shared-mutable-race':
      return {
        lines: [
          `const cache${n}: Record<string, unknown> = {};`,
          `export function resolveTenant${n}(id: string, load: (id: string) => unknown) {`,
          '  // Memoize the tenant across requests.',
          `  cache${n}[id] = load(id);`,
          `  return cache${n}[id];`,
          '}',
        ],
        bugOffset: 3,
        meta: {
          kind,
          severity: 'warn',
          description:
            'A module-level mutable cache is written per request without keying safety; concurrent tenants clobber each other.',
          keywords: ['shared', 'mutable', 'cache', 'race', 'concurrent', 'global'],
        },
      };
  }
}

// --- Filler snippets (bug-free) -------------------------------------------

function fillerSnippet(idx: number): string[] {
  const n = idx;
  const variants: string[][] = [
    [
      `export function formatCurrency${n}(cents: number, currency = "USD"): string {`,
      '  const amount = cents / 100;',
      '  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);',
      '}',
    ],
    [
      `export function slugify${n}(input: string): string {`,
      '  return input',
      '    .toLowerCase()',
      '    .trim()',
      '    .replace(/[^a-z0-9]+/g, "-")',
      '    .replace(/^-+|-+$/g, "");',
      '}',
    ],
    [
      `export function clamp${n}(value: number, min: number, max: number): number {`,
      '  if (value < min) return min;',
      '  if (value > max) return max;',
      '  return value;',
      '}',
    ],
    [
      `export function groupById${n}<T extends { id: string }>(rows: T[]): Map<string, T> {`,
      '  const out = new Map<string, T>();',
      '  for (const row of rows) out.set(row.id, row);',
      '  return out;',
      '}',
    ],
  ];
  return variants[n % variants.length];
}

// --- Assembly -------------------------------------------------------------

function fileHeader(path: string): string[] {
  return [`// ${path}`, '// Auto-generated fixture module for the input-mode eval.', ''];
}

/** Build a bug file: short, so rank-before-drop tends to under-serve it. */
function buildBugFile(
  path: string,
  kind: BugKind,
  idx: number,
): { file: SyntheticFile; bug: PlantedBug } {
  const header = fileHeader(path);
  const lead = fillerSnippet(idx);
  const snippet = bugSnippet(kind, idx);
  const lines = [...header, ...lead, '', ...snippet.lines, ''];
  // Absolute 1-based line of the bug statement in the assembled file.
  const bugLine = header.length + lead.length + 1 + (snippet.bugOffset ?? 0) + 1;
  const meta = snippet.meta!;
  return {
    file: { path, content: lines.join('\n'), hasBug: true },
    bug: {
      id: `${kind}-${idx}`,
      kind,
      file: path,
      line: bugLine,
      severity: meta.severity,
      description: meta.description,
      keywords: meta.keywords,
    },
  };
}

/** Build a large bug-free filler file to consume the char budget. */
function buildFillerFile(path: string, approxLines: number, seed: number): SyntheticFile {
  const lines = [...fileHeader(path)];
  let i = seed;
  while (lines.length < approxLines) {
    lines.push(...fillerSnippet(i), '');
    i += 1;
  }
  return { path, content: lines.join('\n'), hasBug: false };
}

function unifiedAddDiff(file: SyntheticFile): string {
  const body = file.content.split('\n');
  const added = body.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${file.path} b/${file.path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file.path}`,
    `@@ -0,0 +1,${body.length} @@`,
    added,
  ].join('\n');
}

/**
 * Generate a synthetic multi-file review. Bug files and filler files are
 * interleaved so the diff isn't trivially "bugs first". Files are partitioned
 * across `commits` commits round-robin, and each planted bug's absolute new-side
 * line is recorded in `groundTruth`.
 */
export function generateSyntheticReview(spec: SyntheticSpec): SyntheticReview {
  const files: SyntheticFile[] = [];
  const groundTruth: PlantedBug[] = [];

  const bugFiles = spec.bugs.map((kind, i) => {
    const path = `src/${kind.replace(/-/g, '_')}_${i}.ts`;
    return buildBugFile(path, kind, i);
  });
  const fillerFiles = Array.from({ length: spec.fillerFiles }, (_, i) =>
    buildFillerFile(`src/module_${i}.ts`, spec.fillerLinesPerFile, i),
  );

  // Interleave: spread bug files through the filler set so a lazy reader that
  // stops early misses some. Deterministic stride placement.
  const total = bugFiles.length + fillerFiles.length;
  const stride = Math.max(1, Math.floor(total / Math.max(1, bugFiles.length)));
  let bi = 0;
  let fi = 0;
  for (let pos = 0; pos < total; pos += 1) {
    if (bi < bugFiles.length && pos % stride === Math.floor(stride / 2)) {
      files.push(bugFiles[bi].file);
      groundTruth.push(bugFiles[bi].bug);
      bi += 1;
    } else if (fi < fillerFiles.length) {
      files.push(fillerFiles[fi]);
      fi += 1;
    } else if (bi < bugFiles.length) {
      files.push(bugFiles[bi].file);
      groundTruth.push(bugFiles[bi].bug);
      bi += 1;
    }
  }

  const diff = files.map(unifiedAddDiff).join('\n');

  const commitCount = Math.max(1, spec.commits ?? 1);
  const commits: SyntheticCommit[] = Array.from({ length: commitCount }, (_, c) => ({
    message:
      c === 0 ? 'feat: scaffold service modules' : `feat: add service modules (part ${c + 1})`,
    files: [],
  }));
  files.forEach((file, i) => commits[i % commitCount].files.push(file.path));

  return {
    files,
    diff,
    commits,
    groundTruth,
    totalChars: diff.length,
  };
}
