import type { Discussion } from './gitlab.js';
import type { Fingerprints, ReviewComment, Side } from './types.js';
export declare function sha256(input: string): string;
export declare function normalizeBody(body: string): string;
export declare function extractDiffHunkContext(diff: string, file: string, line: number, side: Side): string;
export declare function fingerprints(comment: ReviewComment, hunkContext: string): Fingerprints;
export declare function appendFingerprintMarkers(body: string, fp: Fingerprints): string;
export declare function extractExistingFingerprints(discussions: Discussion[]): Set<string>;
