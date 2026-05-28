import { readFile } from 'node:fs/promises';

export class JsonFileRuleRepository {
  constructor(path) {
    this.path = path;
  }
  async getRules() {
    if (!this._cache) {
      const raw = await readFile(this.path, 'utf8');
      this._cache = JSON.parse(raw);
    }
    return this._cache;
  }
}
