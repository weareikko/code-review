export declare function git(args: string[]): Promise<string>;
export declare function prepareGitHistory(source: string, target: string): Promise<void>;
export declare function getMergeDiff(targetBranch: string): Promise<string>;
