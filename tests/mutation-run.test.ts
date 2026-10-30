import { describe, expect, it } from 'vitest';

import { runSuites } from '../scripts/mutation-run.mjs';

/**
 * The mutation gate's verdicts, checked on one-test files whose outcome is
 * known. The checks read the structure of vitest's JSON report, never the
 * wording of an error, so a vitest update that rewords a message cannot
 * change a verdict.
 */
const fixtures = new URL('./fixtures/mutation/', import.meta.url);

describe('mutation verdicts', () => {
	it('passes a green run', async () => {
		expect(await runSuites(fixtures, ['passes.test.mjs'])).toMatchObject({ verdict: 'passed' });
	});

	it.each(['asserts.test.mjs', 'throws.test.mjs', 'times-out.test.mjs'])('counts any failing test as a kill: %s', async (file) => {
		expect(await runSuites(fixtures, [file])).toMatchObject({ verdict: 'killed' });
	});

	it('reports a run that outlives its limit as a timeout', async () => {
		expect(await runSuites(fixtures, ['hangs.test.mjs'], 1_500)).toMatchObject({ verdict: 'timeout' });
	}, 10_000);

	it.each([['cannot-load.test.mjs'], ['empty.test.mjs'], ['passes.test.mjs', 'cannot-load.test.mjs']].map((files) => [files.join(' + '), files] as const))(
		'stops on a run that proves nothing: %s',
		async (_, files) => {
			await expect(runSuites(fixtures, files)).rejects.toThrow(/proves nothing/);
		}
	);
});
