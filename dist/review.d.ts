export type Side = 'RIGHT' | 'LEFT';
export interface ReviewComment {
    file: string;
    line: number;
    side: Side;
    body: string;
    severity?: string;
}
export interface DiffRefs {
    base_sha: string;
    start_sha: string;
    head_sha: string;
}
export interface Fingerprints {
    primary: string;
    secondary: string;
}
export declare function parseReviewMarkdown(markdown: string): ReviewComment[];
export declare function normalizeBody(body: string): string;
export declare function sha256(input: string): string;
export declare function extractDiffHunkContext(diff: string, file: string, line: number, side: Side): string;
export declare function fingerprints(comment: ReviewComment, hunkContext: string): Fingerprints;
export declare function appendFingerprintMarkers(body: string, fp: Fingerprints): string;
export declare function extractExistingFingerprints(discussions: Array<{
    notes: Array<{
        body?: string;
    }>;
}>): Set<string>;
export declare function buildPayload(comment: ReviewComment, body: string, refs: DiffRefs): {
    body: string;
    position: {
        old_line: number;
        position_type: string;
        base_sha: string;
        start_sha: string;
        head_sha: string;
        old_path: string;
        new_path: string;
    } | {
        new_line: number;
        position_type: string;
        base_sha: string;
        start_sha: string;
        head_sha: string;
        old_path: string;
        new_path: string;
    };
};
