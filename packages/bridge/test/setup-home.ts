import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

// The bridge writes ~/.zhunzou/machine.json and runner state; keep test runs out of the real home.
const home = mkdtempSync(join(tmpdir(), 'zhunzou-bridge-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => rmSync(home, { recursive: true, force: true }));
