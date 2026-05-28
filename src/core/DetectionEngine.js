import { detectorRegistry } from './detectors/index.js';

export class DetectionEngine {
  constructor(rules) {
    this.rules = rules;
  }

  evaluate(node) {
    const results = [];
    let weightedSum = 0;
    let definitive = false;
    for (const rule of this.rules.detectors) {
      if (!rule.enabled) continue;
      const detector = detectorRegistry[rule.id];
      if (!detector) continue;
      const res = detector.detect(node, rule.config || {});
      if (res.matched) {
        const weight = rule.weight ?? 1;
        results.push({ id: rule.id, ...res, weight });
        weightedSum += weight * res.confidence;
        if (res.definitive) definitive = true;
      }
    }
    const threshold = this.rules.decision?.minScore ?? 1.0;
    const isModal = definitive || weightedSum >= threshold;
    return { isModal, score: weightedSum, definitive, signals: results };
  }
}
