TODO.md

- preferences: choose between Claude themed colors (default), Gnome active theme colors or custom colors (the gnome list) for the panel progress bars. do not affect logo. consequences for tick contrast and a11y?
- run CI once a forge is reachable again. The workflow was made forge-portable on `chore/project-hardening` but has never executed anywhere, and `on: push` is scoped to `main` — so pushing a branch triggers nothing and a silent forge does not mean green. Needs a PR or a manual `workflow_dispatch`.
- nothing executable asserts that the panel icon tracks the top bar's own foreground rather than the desktop style variant. `panelScheme()` and `_scheme` are different on a light desktop with a dark panel, and that distinction is currently defended only by a comment and a doc paragraph.
