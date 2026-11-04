# Example profile patch

Reference-only audit material — this repo does **not** edit
`~/.dsh/profiles/web/cordis.patch.yml`. The rows below are examples to copy
into a profile patch yourself.

## Swap in the plus engine

`CompactionPlusEngine` exports as the default from `lib/index.js` and
registers service `"compaction"`, so it must **replace** the basic engine,
not load alongside it — two engines would register the same service.
A patch row with the same `id` replaces the base row's fields wholesale
(never deep-merged; see `docs/HARNESS-CONTRACT.md` §5), so restate `name`
as the specifier for this plugin plus any `config` you need:

```yaml
- id: compaction-basic
  name: '@fares/dsh-compaction-plus'
  enabled: true
  config:
    summarizationProvider: fake-provider
    summarizationModel: fake-mini
    thresholdRatio: 0.85
    spillDir: /var/lib/dsh/compaction-spill
```

The base row you are replacing is `id: compaction-basic` /
`name: '@deepseek-ai/dsh-compaction-basic'`. Any other fields the base row
carried (extra `inject`, plugin path, etc.) are dropped by the wholesale
replacement and must be restated if you still need them; this engine only
needs the standard `llm` / `tokenMeter` / `sessions` injections, which it
inherits from the base class.

## Minimal config row

All fields are optional. This mirrors the mount smoke test and is the
smallest useful configuration:

```yaml
summarizationProvider: fake-provider   # cheap summarizer route
summarizationModel: fake-mini
thresholdRatio: 0.85
spillDir: /var/lib/dsh/compaction-spill
```

Base defaults that apply when omitted: `thresholdRatio 0.8`,
`retainRatio 0.16`, `headroomTokens 65536`, `auto true`,
`spillMaxBytes 4 MiB`, `spillSecrets true`, `keepLastToolResults 2`,
`toolResultChars 1200`, `stripReasoning true`, `offloadImages true`,
`lastUserMessages 3`.

Notes on the plus-only knobs:

- `spillDir` defaults to `~/.dsh/compaction-spill`, overridable at runtime
  via the `DSH_COMPACT_PLUS_SPILL_DIR` environment variable. Spill files
  are written `0600` and secret-looking values are redacted by default
  (`spillSecrets: false` opts back into verbatim writes). Set
  `spillDir: null` to disable spill entirely; prune markers then honestly
  say the text was not spilled.

## Per-model policies

`modelPolicies` overrides the base knobs for one provider/model pair:

```yaml
modelPolicies:
  - provider: some-provider
    model: some-model
    thresholdRatio: 0.7
    summarizationProvider: fake-provider
    summarizationModel: fake-mini
```

## Full plus-only row

```yaml
summarizationProvider: fake-provider
summarizationModel: fake-mini
thresholdRatio: 0.8
retainRatio: 0.16
headroomTokens: 65536
spillDir: /var/lib/dsh/compaction-spill
spillMaxBytes: 4194304
spillSecrets: true
keepLastToolResults: 2
toolResultChars: 1200
stripReasoning: true
offloadImages: true
lastUserMessages: 3
auto: true
```
