export function toPiReviewerSeverity(severity) {
    return severity === 'critical' ? 'CRITICAL' : severity === 'warn' ? 'WARN' : 'INFO';
}
export function normalizeSeverity(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'critical' || normalized === 'error' || normalized === '🔴')
        return 'critical';
    if (normalized === 'warn' || normalized === 'warning' || normalized === '🟡')
        return 'warn';
    return 'info';
}
//# sourceMappingURL=types.js.map