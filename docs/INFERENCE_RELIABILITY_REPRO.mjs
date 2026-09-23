// Runs synthetic regression checks; no provider traffic or credentials.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'test/zkapi/inference-reliability.test.cjs'], {cwd:root,stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
