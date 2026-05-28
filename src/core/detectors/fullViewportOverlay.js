export const fullViewportOverlayDetector = {
  id: 'full-viewport-overlay',
  detect(node, config) {
    const position = node.getStyle('position');
    if (config.fixedPositionRequired && position !== 'fixed' && position !== 'absolute') {
      return { matched: false };
    }
    const zIndexStr = node.getStyle('z-index');
    const zIndex = zIndexStr ? parseInt(zIndexStr, 10) : NaN;
    const minZ = config.minZIndex ?? 100;
    if (Number.isNaN(zIndex) || zIndex < minZ) {
      return { matched: false };
    }
    return {
      matched: true,
      confidence: 0.7,
      reason: `position=${position}, z-index=${zIndex}`,
    };
  },
};
