import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.{ts,mjs}'],
		exclude: ['tests/fixtures/**'],
		// Keep test.each titles whole: $name would otherwise be cut at 40 characters.
		taskTitleValueFormatTruncate: 0,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			reporter: ['text', 'json-summary'],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100
			}
		}
	}
});
