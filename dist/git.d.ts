export interface GitOptions {
    cwd?: string;
}
export interface PrepareGitHistoryOptions extends GitOptions {
    remote?: string;
    codeQualityArtifacts?: string[];
}
export declare function git(args: string[], options?: GitOptions): Promise<string>;
export declare function removeGeneratedCodeQualityArtifacts(paths?: string[], options?: GitOptions): Promise<string[]>;
export declare function prepareGitHistory(sourceBranch: string, targetBranch: string, options?: PrepareGitHistoryOptions): Promise<void>;
export declare function getMergeDiff(targetBranch: string, options?: GitOptions & {
    remote?: string;
    context?: number;
}): Promise<string>;
//# sourceMappingURL=git.d.ts.map