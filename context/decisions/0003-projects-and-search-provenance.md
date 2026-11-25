# ADR 0003: Registered projects and search provenance

Projects are registered as absolute, existing, realpath-resolved Git
directories in configuration. The V2 store already contains all search
provenance, so it now exposes a read-only query method without migration.
