import { test } from 'vitest';
import './broken.mjs';
test('unreached', () => {});
