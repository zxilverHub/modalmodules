import { ariaDialogDetector } from './ariaDialog.js';
import { classNamePatternDetector } from './classNamePattern.js';
import { fullViewportOverlayDetector } from './fullViewportOverlay.js';
import { selectorMatchDetector } from './selectorMatch.js';

// HOW TO ADD A NEW DETECTOR
// 1. Create a file in this folder that exports an object:
//      { id: 'my-detector',
//        detect(node, config) {
//          // node implements NodeAdapter (see src/core/NodeAdapter.js)
//          // return { matched, confidence: 0..1, reason: string, definitive?: boolean }
//        } }
// 2. Register it in `detectorRegistry` below.
// 3. Add an entry to spec/rules.default.json (or your custom rules JSON):
//      { "id": "my-detector", "enabled": true, "weight": 1.0, "config": { ... } }
//
// For pure config tweaks (new class-name regex, higher z-index threshold, etc.)
// you only need step 3 — no code changes.

export const detectorRegistry = {
  [ariaDialogDetector.id]: ariaDialogDetector,
  [classNamePatternDetector.id]: classNamePatternDetector,
  [fullViewportOverlayDetector.id]: fullViewportOverlayDetector,
  [selectorMatchDetector.id]: selectorMatchDetector,
};

export function registerDetector(detector) {
  detectorRegistry[detector.id] = detector;
}
