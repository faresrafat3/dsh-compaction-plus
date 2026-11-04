# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

*This changelog was written with AI assistance; verify claims against `src/`.*

## [Unreleased]

- Initial repository scaffold: package manifest, TypeScript config, placeholder
  entry point, docs stubs.

## [0.1.0]

- `CompactionPlusEngine`: subclass of `BasicCompactionEngine` that runs a
  four-stage pipeline (free prune, base summarization, local spill,
  image offload by reference) from the protected `summarize()` override.
- `SpillStore` with per-session JSONL persistence and keyword search;
  spill failures never fail compaction.
- Deterministic prune-only fallback summary on summarizer failure; aborts
  are always rethrown.
- Unit tests for prune, spill, image, and fallback logic plus one Cordis
  mount smoke test; CI (typecheck, build, test on push/PR).
- Playwright/browser automation coverage is explicitly out of scope.
