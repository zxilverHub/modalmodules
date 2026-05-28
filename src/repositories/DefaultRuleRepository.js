import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_PATH = resolve(here, '../../spec/rules.default.json');

export class DefaultRuleRepository {
  async getRules() {
    if (!this._cache) {
      const raw = await readFile(DEFAULT_RULES_PATH, 'utf8');
      this._cache = JSON.parse(raw);
    }
    return this._cache;
  }
}
