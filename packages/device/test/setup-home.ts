import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

// The device daemon writes ~/.zhunzou/machine.json; keep test runs out of the real home.
const home = mkdtempSync(join(tmpdir(), 'zhunzou-device-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => rmSync(home, { recursive: true, force: true }));
