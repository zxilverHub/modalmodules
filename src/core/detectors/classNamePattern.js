export const classNamePatternDetector = {
  id: 'class-name-pattern',
  detect(node, config) {
    const classes = node.getClasses();
    if (classes.length === 0) return { matched: false };
    const haystack = classes.join(' ');
    const patterns = config.patterns || [];
    let best = null;
    for (const entry of patterns) {
      let re;
      try { re = new RegExp(entry.pattern, 'i'); } catch { continue; }
      if (re.test(haystack)) {
        if (!best || entry.confidence > best.confidence) {
          best = { confidence: entry.confidence, pattern: entry.pattern };
        }
      }
    }
    if (!best) return { matched: false };
    return {
      matched: true,
      confidence: best.confidence,
      reason: `class matches /${best.pattern}/i`,
    };
  },
};
