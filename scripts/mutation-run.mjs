import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vitest = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vitest', 'vitest.mjs');

/**
 * Run `tests` under vitest in `cwd` and say what the run proves (R-8.2.1).
 *
 * `passed` when every test passed, `killed` when any test failed, `timeout`
 * when the run outlived `limit`. A run in which a file failed to load or no
 * test ran proves nothing, and throws. The verdict comes from the structure of
 * the JSON report, never from the wording of an error.
 *
 * @param {string | URL} cwd
 * @param {readonly string[]} tests
 * @param {number} [limit]
 * @returns {Promise<{ verdict: 'passed' | 'killed' | 'timeout', output: string }>}
 */
export async function runSuites(cwd, tests, limit = 45_000) {
	const directory = await mkdtemp(join(tmpdir(), 'schemd-circuitikz-mutation-report-'));
	try {
		const reportPath = join(directory, 'report.json');
		const result = spawnSync(process.execPath, [vitest, 'run', ...tests, '--reporter=json', `--outputFile=${reportPath}`], {
			cwd: cwd instanceof URL ? fileURLToPath(cwd) : cwd,
			env: { ...process.env, FORCE_COLOR: '0' },
			encoding: 'utf8',
			timeout: limit
		});
		const output = `${result.stdout}${result.stderr}`;
		if (result.error?.code === 'ETIMEDOUT') return { verdict: 'timeout', output };
		if (result.error !== undefined) throw result.error;
		const report = JSON.parse(await readFile(reportPath, 'utf8'));
		const unloaded = report.testResults.filter((file) => file.message !== '').map((file) => file.name);
		if (report.numTotalTests === 0 || unloaded.length > 0) {
			throw new Error(`The run proves nothing: ${unloaded.length > 0 ? `${unloaded.join(', ')} failed to load` : 'no test ran'}.\n${output}`);
		}
		return { verdict: report.numFailedTests > 0 ? 'killed' : 'passed', output };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
