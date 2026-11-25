# ADR 0002: Local Ollama embedding configuration

`embedding` defaults to local Ollama at `http://localhost:11434` using
`nomic-embed-text`. Only root-path HTTP URLs hosted by `localhost` or
`127.0.0.1` are valid. Embedding values are cached by content hash in the
existing derived-store `meta` table; vector storage remains pending.
