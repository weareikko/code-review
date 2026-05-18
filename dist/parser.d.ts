import { type ReviewComment } from './types.js';
export interface ParseResult {
    comments: ReviewComment[];
    warnings: string[];
}
export declare function parseReviewMarkdownWithWarnings(markdown: string): ParseResult;
export declare function parseReviewMarkdown(markdown: string): ReviewComment[];
//# sourceMappingURL=parser.d.ts.map