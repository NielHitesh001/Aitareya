# ADR 0005: Two launchd jobs for the ctx daemon

`ctx watch` and `ctx api serve` run as separate user launchd jobs:
`sh.ctx.watch` and `sh.ctx.api`. A launchd job has one `ProgramArguments`
process, and separate jobs give each process independent `KeepAlive` behavior.
Both write actions-only output to the same local daemon log.
