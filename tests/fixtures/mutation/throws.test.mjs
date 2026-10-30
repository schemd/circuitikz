import { test } from 'vitest';
test('crashes', () => { throw new TypeError('the code under test threw'); });
