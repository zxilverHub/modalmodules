import { readFile } from 'node:fs/promises';
import { ModalRemovalService } from '../services/ModalRemovalService.js';
import { DefaultRuleRepository } from '../repositories/DefaultRuleRepository.js';
import { JsonFileRuleRepository } from '../repositories/JsonFileRuleRepository.js';
import { createCheerioAdapter } from '../adapters/CheerioAdapter.js';
import { createLogger } from '../util/logger.js';

async function loadPreferences(opts) {
  if (opts.preferences) return opts.preferences;
  if (opts.preferencesPath) {
    const raw = await readFile(opts.preferencesPath, 'utf8');
    return JSON.parse(raw);
  }
  return null;
}

export async function removeModalsFromHTML(html, options = {}) {
  const ruleRepository =
    options.ruleRepository ??
    (options.rulesPath
      ? new JsonFileRuleRepository(options.rulesPath)
      : new DefaultRuleRepository());
  const logger = createLogger(options.log);
  const preferences = await loadPreferences(options);
  const service = new ModalRemovalService({
    ruleRepository,
    adapterFactory: createCheerioAdapter,
  });
  const { removed, cleanup, output } = await service.run(html, { logger, preferences });
  return { html: output, removed, cleanup };
}
