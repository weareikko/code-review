import type { Config } from './config.js';
import type { GeneratedComment } from './types.js';
export interface RunResult {
    generated: GeneratedComment[];
    posted: number;
}
export declare function run(config: Config): Promise<RunResult>;
export declare function main(argv?: string[]): Promise<void>;
