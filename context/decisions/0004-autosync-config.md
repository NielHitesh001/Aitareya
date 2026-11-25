# ADR 0004: Explicit auto-sync configuration

`autoSync` is a boolean configuration setting that defaults to `false`.
Enabling it permits watch mode to report pending synchronizations, but it does
not bypass the existing confirmation gate. Without `--yes`, watch mode never
writes generated rules files.
