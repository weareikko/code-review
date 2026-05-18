import { normalizeSeverity } from './types.js';
const HEADER_RE = /^\s*(?<emoji>[🔴🟡🔵])?\s*(?<file>.+):(\d+)\s+\((?<side>LEFT|RIGHT)\)\s*$/u;
const GITHUB_STYLE_HEADER_RE = /^\s*(?<emoji>[🔴🟡🔵])?\s*(?:\*\*)?`?(?<file>.+):(\d+)`?(?:\*\*)?\s*(?:[·-]|\()\s*(?<side>LEFT|RIGHT)\)?\s*$/u;
const FINGERPRINT_MARKER_RE = /<!--\s*pi-reviewer:fingerprint-(?:primary|secondary):[a-f0-9]+\s*-->/gi;
function severityFromEmoji(emoji) {
    if (emoji === '🔴')
        return 'critical';
    if (emoji === '🟡')
        return 'warn';
    return 'info';
}
function inferSeverity(body, fallback) {
    const first = body.trimStart()[0];
    if (first === '🔴' || first === '🟡' || first === '🔵')
        return normalizeSeverity(first);
    return fallback;
}
function normalizeSide(value) {
    return String(value ?? '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
}
function addJsonComment(out, item) {
    if (!item || typeof item !== 'object')
        return;
    const value = item;
    const file = value.file ?? value.path ?? value.new_path ?? value.old_path;
    const rawLine = value.line ?? value.new_line ?? value.old_line;
    const line = Number(rawLine);
    const body = String(value.body ?? value.comment ?? value.message ?? '').replace(FINGERPRINT_MARKER_RE, '').trim();
    const side = normalizeSide(value.side ?? (value.old_line ? 'LEFT' : 'RIGHT'));
    if (typeof file === 'string' && file.length > 0 && Number.isInteger(line) && line > 0 && body.length > 0) {
        out.push({ file, line, side, severity: normalizeSeverity(value.severity), body });
    }
}
function parseJsonComments(markdown, out) {
    const fence = /```json\s*([\s\S]*?)```/gi;
    for (const match of markdown.matchAll(fence)) {
        try {
            const parsed = JSON.parse(match[1] ?? '');
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.comments) ? parsed.comments : [];
            for (const item of list)
                addJsonComment(out, item);
        }
        catch {
            // Ignore unrelated JSON fences; terminal parsing below will still run.
        }
    }
    const marker = /<!--\s*pi-reviewer-comment\s*([\s\S]*?)-->/gi;
    for (const match of markdown.matchAll(marker)) {
        try {
            addJsonComment(out, JSON.parse(match[1] ?? ''));
        }
        catch {
            // Ignore malformed legacy comment markers.
        }
    }
}
function matchHeader(line) {
    const match = line.match(HEADER_RE) ?? line.match(GITHUB_STYLE_HEADER_RE);
    if (!match?.groups)
        return null;
    const rawLine = match[3];
    const number = Number(rawLine);
    if (!Number.isInteger(number) || number <= 0)
        return null;
    return {
        file: match.groups.file.trim().replace(/^`|`$/g, ''),
        line: number,
        side: match.groups.side,
        severity: severityFromEmoji(match.groups.emoji),
    };
}
function parseInlineSection(markdown, out, warnings) {
    const marker = markdown.search(/^==\s*Inline Comments\s*==\s*$/im);
    if (marker === -1)
        return;
    const section = markdown.slice(marker).split(/\r?\n/).slice(1);
    let current = null;
    let sawBodyBeforeHeader = false;
    const flush = () => {
        if (!current)
            return;
        const body = current.body.join('\n').replace(FINGERPRINT_MARKER_RE, '').trim();
        if (body.length > 0) {
            out.push({
                file: current.file,
                line: current.line,
                side: current.side,
                severity: inferSeverity(body, current.severity),
                body,
            });
        }
        current = null;
    };
    for (const rawLine of section) {
        if (/^==\s*[^=].*==\s*$/.test(rawLine))
            break;
        const header = matchHeader(rawLine);
        if (header) {
            flush();
            current = { ...header, body: [] };
            continue;
        }
        if (current) {
            current.body.push(rawLine);
        }
        else if (rawLine.trim().length > 0) {
            sawBodyBeforeHeader = true;
        }
    }
    flush();
    if (sawBodyBeforeHeader) {
        warnings.push('Ignored text in the inline comments section before the first parseable comment header.');
    }
}
export function parseReviewMarkdownWithWarnings(markdown) {
    const comments = [];
    const warnings = [];
    parseJsonComments(markdown, comments);
    parseInlineSection(markdown, comments, warnings);
    return { comments, warnings };
}
export function parseReviewMarkdown(markdown) {
    return parseReviewMarkdownWithWarnings(markdown).comments;
}
//# sourceMappingURL=parser.js.map