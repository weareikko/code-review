import { type Severity } from './types.js';
export type GitLabAuthHeader = 'PRIVATE-TOKEN' | 'JOB-TOKEN';
export interface Config {
    project: string;
    mr: string;
    gitlabUrl: string;
    gitlabToken: string;
    gitlabAuthHeader: GitLabAuthHeader;
    model: string;
    minSeverity: Severity;
    apiKey: string;
    reviewFile: string;
    output: string;
    dryRun: boolean;
    noPost: boolean;
    cwd: string;
}
export type ParsedArgs = Record<string, string | boolean>;
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function resolveConfig(argv?: string[], env?: NodeJS.ProcessEnv): Config;
export declare function validateConfig(config: Config): void;
export { type Severity };
