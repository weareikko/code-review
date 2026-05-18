import { createHash } from 'node:crypto';
export function parseReviewMarkdown(markdown) {
    const comments = [];
    const section = markdown.match(/== Inline Comments ==\s*([\s\S]*?)(?:\n== |$)/);
    if (section) {
        const header = /^(?:(🟢|🟡|🔴|⚪️)\s*)?([^:\n]+):(\d+) \((LEFT|RIGHT)\)\s*$/gm;
        const matches = [...section[1].matchAll(header)];
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const start = (match.index ?? 0) + match[0].length;
            const end = i + 1 < matches.length ? matches[i + 1].index ?? section[1].length : section[1].length;
            const body = section[1].slice(start, end).trim();
            if (body)
                comments.push({ file: match[2].trim(), line: Number(match[3]), side: match[4], severity: severityFromEmoji(match[1]), body });
        }
    }
    const fence = /```json\s*([\s\S]*?)```/gi;
    for (const match of markdown.matchAll(fence)) {
        try {
            const parsed = JSON.parse(match[1]);
            const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.comments) ? parsed.comments : []);
            for (const item of list)
                addComment(comments, item);
        }
        catch { /* ignore non-comment json */ }
    }
    const marker = /<!--\s*pi-reviewer-comment\s*([\s\S]*?)-->/gi;
    for (const match of markdown.matchAll(marker)) {
        try {
            addComment(comments, JSON.parse(match[1]));
        }
        catch { /* ignore */ }
    }
    return comments;
}
function severityFromEmoji(emoji) {
    if (emoji === '🔴')
        return 'error';
    if (emoji === '🟡')
        return 'warning';
    if (emoji === '🟢')
        return 'info';
    return undefined;
}
function addComment(out, item) {
    const file = item.file ?? item.path ?? item.new_path ?? item.old_path;
    const line = Number(item.line ?? item.new_line ?? item.old_line);
    const body = String(item.body ?? item.comment ?? item.message ?? '').trim();
    const side = (item.side ?? (item.old_line ? 'LEFT' : 'RIGHT')).toUpperCase();
    if (file && line > 0 && body)
        out.push({ file, line, body, side: side === 'LEFT' ? 'LEFT' : 'RIGHT', severity: item.severity });
}
export function normalizeBody(body) {
    return body.replace(/<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/g, '').replace(/\s+/g, ' ').trim();
}
export function sha256(input) { return createHash('sha256').update(input).digest('hex'); }
export function extractDiffHunkContext(diff, file, line, side) {
    let currentNew = '', currentOld = '';
    const lines = diff.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (lineText.startsWith('diff --git ')) {
            currentNew = '';
            currentOld = '';
        }
        const fileMatch = lineText.match(/^\+\+\+ b\/(.*)$/);
        if (fileMatch)
            currentNew = fileMatch[1];
        const oldMatch = lineText.match(/^--- a\/(.*)$/);
        if (oldMatch)
            currentOld = oldMatch[1];
        if (lineText.startsWith('@@') && (currentNew === file || currentOld === file)) {
            const hunkStart = i;
            const m = lineText.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (!m)
                continue;
            let oldLine = Number(m[1]);
            let newLine = Number(m[2]);
            for (let j = i + 1; j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git '); j++) {
                const prefix = lines[j][0];
                const hit = side === 'RIGHT' ? (prefix !== '-' && newLine === line) : (prefix !== '+' && oldLine === line);
                if (hit)
                    return lines.slice(hunkStart, j + 1).join('\n');
                if (prefix !== '+')
                    oldLine++;
                if (prefix !== '-')
                    newLine++;
            }
        }
    }
    return `${file}:${side}:${line}`;
}
export function fingerprints(comment, hunkContext) {
    const bodyHash = sha256(normalizeBody(comment.body));
    const hunkHash = sha256(hunkContext);
    return {
        primary: sha256([comment.file, comment.side, comment.line, bodyHash, hunkHash].join('|')),
        secondary: sha256([comment.file, comment.side, bodyHash, hunkHash].join('|')),
    };
}
export function appendFingerprintMarkers(body, fp) {
    return `${body.trim()}\n\n<!-- pi-reviewer:fingerprint-primary:${fp.primary} -->\n<!-- pi-reviewer:fingerprint-secondary:${fp.secondary} -->`;
}
export function extractExistingFingerprints(discussions) {
    const set = new Set();
    const re = /pi-reviewer:fingerprint-(?:primary|secondary):([a-f0-9]+)/g;
    for (const d of discussions)
        for (const n of d.notes ?? [])
            for (const m of (n.body ?? '').matchAll(re))
                set.add(m[1]);
    return set;
}
export function buildPayload(comment, body, refs) {
    return {
        body,
        position: {
            position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
            old_path: comment.file, new_path: comment.file,
            ...(comment.side === 'LEFT' ? { old_line: comment.line } : { new_line: comment.line }),
        },
    };
}
//# sourceMappingURL=review.js.map