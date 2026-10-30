import { test } from 'vitest';
test('never settles', () => new Promise(() => {}), 30);
