TODO.md

- preferences: choose between Claude themed colors (default), Gnome active theme colors or custom colors (the gnome list) for the panel progress bars. do not affect logo. consequences for tick contrast and a11y?
- Node's coverage thresholds are aggregate-only, so a single `lib/` module can regress below the 95% branch floor while the total stays green. A per-file check would close it.
