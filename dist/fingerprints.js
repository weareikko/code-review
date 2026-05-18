import { createHash } from 'node:crypto';
const FINGERPRINT_MARKER_RE = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):([a-f0-9]+)\s*-->/gi;
const STRIP_FINGERPRINT_MARKER_RE = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/gi;
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
export function normalizeBody(body) {
    return body
        .replace(STRIP_FINGERPRINT_MARKER_RE, '')
        .replace(/^[🔴🟡🔵]\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function matchesFile(state, file) {
    return state.oldPath === file || state.newPath === file;
}
function parseHunkHeader(line) {
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!match)
        return null;
    return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}
function hunkContainsLine(hunkLines, targetLine, side, startOld, startNew) {
    let oldLine = startOld;
    let newLine = startNew;
    for (const text of hunkLines.slice(1)) {
        const prefix = text[0] ?? ' ';
        if (side === 'RIGHT' && prefix !== '-' && newLine === targetLine)
            return true;
        if (side === 'LEFT' && prefix !== '+' && oldLine === targetLine)
            return true;
        if (prefix !== '+')
            oldLine += 1;
        if (prefix !== '-')
            newLine += 1;
    }
    return false;
}
export function extractDiffHunkContext(diff, file, line, side) {
    const lines = diff.split('\n');
    const state = { oldPath: '', newPath: '' };
    for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i];
        if (text.startsWith('diff --git ')) {
            state.oldPath = '';
            state.newPath = '';
            continue;
        }
        const oldMatch = text.match(/^--- (?:a\/(.*)|\/dev\/null)$/);
        if (oldMatch)
            state.oldPath = oldMatch[1] ?? '/dev/null';
        const newMatch = text.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
        if (newMatch)
            state.newPath = newMatch[1] ?? '/dev/null';
        if (!text.startsWith('@@') || !matchesFile(state, file))
            continue;
        const header = parseHunkHeader(text);
        if (!header)
            continue;
        let end = i + 1;
        while (end < lines.length && !lines[end].startsWith('@@') && !lines[end].startsWith('diff --git ')) {
            end += 1;
        }
        const hunkLines = lines.slice(i, end);
        if (hunkContainsLine(hunkLines, line, side, header.oldLine, header.newLine)) {
            return hunkLines.join('\n');
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
    for (const discussion of discussions) {
        for (const note of discussion.notes ?? []) {
            for (const match of String(note.body ?? '').matchAll(FINGERPRINT_MARKER_RE)) {
                set.add(match[1]);
            }
        }
    }
    return set;
}
//# sourceMappingURL=fingerprints.js.map