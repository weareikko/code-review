export type Severity = 'info' | 'warning' | 'error';
export interface Config {
    project: string;
    mr: string;
    gitlabUrl: string;
    gitlabToken: string;
    model: string;
    minSeverity: Severity;
    apiKey: string;
    reviewFile: string;
    output: string;
    dryRun: boolean;
    noPost: boolean;
}
export declare function parseArgs(argv: string[]): Record<string, string | boolean>;
export declare function helpText(): string;
export declare function resolveConfig(argv?: string[], env?: NodeJS.ProcessEnv): Config;
export declare function validateConfig(config: Config): void;
