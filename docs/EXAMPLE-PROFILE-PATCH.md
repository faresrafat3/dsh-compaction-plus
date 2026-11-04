# Example profile patch

Reference-only audit material — this repo does **not** edit
`~/.dsh/profiles/web/cordis.patch.yml`. The rows below are examples to copy
into a profile patch yourself.

## Swap in the plus engine

`CompactionPlusEngine` exports as the default from `lib/index.js` and
registers service `"compaction"`, so it drops into any `plugins:` list that
currently carries the basic engine. Example row:

```yaml
- id: dsh-compaction-plus
  name: plus-compaction
  enabled: true
  ...
```

The actual patch dialect of your harness profile (keys, quoting, and where
the plugin path lives) governs — copy the shape of an existing
`compaction-basic` row in your patch file rather than inventing new keys.

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
`spillMaxBytes 4 MiB`, `keepLastToolResults 2`, `toolResultChars 1200`,
`stripReasoning true`, `offloadImages true`, `lastUserMessages 3`.

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
keepLastToolResults: 2
toolResultChars: 1200
stripReasoning: true
offloadImages: true
lastUserMessages: 3
auto: true
```
