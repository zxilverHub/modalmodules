// Matches a node against a list of full CSS selectors. Used for known consent
// vendor signatures (#onetrust-consent-sdk, #CybotCookiebotDialog, ...) where
// class-name regex is the wrong tool — vendors use IDs, attribute combos, and
// fixed class names that are easier to express as selectors.
export const selectorMatchDetector = {
  id: 'selector-match',
  detect(node, config) {
    for (const entry of config.selectors || []) {
      if (node.matches(entry.selector)) {
        return {
          matched: true,
          confidence: entry.confidence ?? 0.9,
          reason: entry.vendor
            ? `${entry.vendor} signature (${entry.selector})`
            : `matches ${entry.selector}`,
        };
      }
    }
    return { matched: false };
  },
};
