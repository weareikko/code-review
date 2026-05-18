import type { Config } from './config.js';
import { type PiReviewerSeverity } from './types.js';
export interface PiReviewerOptions {
    cwd?: string;
    diff?: string;
    review?: PiReviewFunction;
}
export interface PiReviewOptions {
    cwd?: string;
    diff?: string;
    branch?: string;
    output?: 'terminal' | 'comment' | 'file';
    dryRun?: boolean;
    piApiKey?: string;
    model?: string;
    minSeverity?: PiReviewerSeverity;
}
export type PiReviewFunction = (options: PiReviewOptions) => Promise<void>;
export declare function runPiReviewer(config: Config, options?: PiReviewerOptions): Promise<void>;
