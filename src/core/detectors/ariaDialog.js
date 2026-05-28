export const ariaDialogDetector = {
  id: 'aria-dialog',
  detect(node) {
    const role = node.getAttr('role');
    const ariaModal = node.getAttr('aria-modal');
    const isDialog = role === 'dialog' || role === 'alertdialog';
    const isModalFlag = ariaModal === 'true';
    if (isDialog && isModalFlag) {
      return { matched: true, confidence: 1.0, reason: 'role=dialog + aria-modal=true', definitive: true };
    }
    if (isDialog) {
      return { matched: true, confidence: 0.8, reason: `role=${role}` };
    }
    if (isModalFlag) {
      return { matched: true, confidence: 0.7, reason: 'aria-modal=true' };
    }
    return { matched: false };
  },
};
