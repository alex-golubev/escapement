/** Text being typed, in a field or one that says so (`data-typing`): its keys are its own, an undo of its own among them. */
export const typing = ({ target, isComposing }: KeyboardEvent) =>
  isComposing ||
  (target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.dataset.typing === 'true'))
