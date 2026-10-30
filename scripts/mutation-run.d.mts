export function runSuites(
	cwd: string | URL,
	tests: readonly string[],
	limit?: number
): Promise<{ verdict: 'passed' | 'killed' | 'timeout'; output: string }>;
