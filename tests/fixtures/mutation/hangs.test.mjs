import { test } from 'vitest';
/* Busy for longer than the run may take, then done, so no worker is left spinning. */
test('hangs', () => { const end = performance.now() + 4000; while (performance.now() < end); });
