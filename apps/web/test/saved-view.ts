/** A view as the page saves it for a project: a new project's, but for `changed`. */
export const savedView = (changed: object) => ({
  version: 3,
  centre: 'arrangement',
  below: null,
  panel: { share: 40, folded: false },
  scroll: { arrangement: { down: 0, across: 0 }, rack: 0 },
  ...changed
})
