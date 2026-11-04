# Context Compaction / Context Management Research Dossier

**Date:** 2026-11-04
**Scope:** Best context-compaction, context-management and long-context memory systems as of 2026 (academic + open-source), for a DSH agent-assistant compaction plugin.
**Method note:** `web_search` returned HTTP 401 (invalid DeepSeek API key in this session), so research was done via direct `web_fetch` and bash `curl` against primary docs and arXiv. Claims that could not be verified from a fetched source are marked `[unverified]`.

---

## 1. Comparison table — top systems

| # | System | Representative source | Mechanism | Compressed / kept | Token / latency cost | Maturity | License |
|---|---|---|---|---|---|---|---|
| 1 | **MemGPT / Letta** | [MemGPT paper (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560); [letta-ai/letta (GitHub API)](https://github.com/letta-ai/letta) | OS-like virtual context management: hierarchical memory tiers (in-context / recall / archival), the LLM itself pages data between tiers via function calls / interrupts, giving the appearance of extended context inside a fixed window. | Keeps hot items in context; evicts to external recall/archive stores; recalls on demand. Nothing is destroyed — it is paged out. | Extra function-call round-trips per paging decision; recall search adds retrieval latency. Cost is paid per eviction/recall, not per turn. | Research prototype (2023, UC Berkeley) evolved into a maintained OSS platform (25,344 stars, last push 2026-10-18 per GitHub API). | MemGPT paper code at memgpt.ai; Letta repo **Apache-2.0** (GitHub API `license.spdx_id`). |
| 2 | **Anthropic — server-side compaction** | [Anthropic compaction.md](https://platform.claude.com/docs/en/build-with-claude/compaction.md); [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing.md) | Server-side: as the conversation grows, Claude replaces older turns with a Claude-written summary before the next response. Modes: on-demand, threshold-triggered, client-side. Anthropic calls it "the primary strategy" for most use cases. | Older turns summarized away; summary kept in context. | Runs on the API side; no client summarizer prompt to hand-roll, but summary generation consumes tokens. | First-party, GA-style API feature with beta header for context editing (`context-management-2025-06-27`). | Proprietary (Claude API). |
| 3 | **Anthropic — context editing** | [context-editing.md](https://platform.claude.com/docs/en/build-with-claude/context-editing.md) | Fine-grained clearing: tool-result clearing (`clear_tool_uses_20250919`) and thinking-block clearing (`clear_thinking_20251015`) prune old tool results / thinking blocks client-designated as disposable. | Old tool results and thinking blocks cleared; user text and recent turns kept verbatim. | Cheap — deterministic pruning, no summarizer call. The cheapest compaction primitive. | First-party beta, tool-specific defaults. | Proprietary (Claude API). |
| 4 | **LangGraph** | [LangGraph README](https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md); [LangGraph memory docs](https://docs.langchain.com/oss/python/langgraph/memory) | Low-level orchestration framework for stateful, long-running agents: durable execution (persist through failures, resume), human-in-the-loop interrupts, and checkpointed state plus short/long-term memory primitives. Compaction is built from these: serialize state, summarize, rehydrate. | State checkpointed to a store; summarized segments kept, raw history in the checkpointer store. | Checkpointer writes add IO per step; summarization cost only when invoked. | Mature OSS, MIT, widely adopted (Klarna/Replit/Elastic cited in README). | **MIT** (PyPI license badge in README). |
| 5 | **LlamaIndex** | [LlamaIndex README](https://raw.githubusercontent.com/run-llama/llama_index/main/README.md); [LlamaIndex memory docs (developers.llamaindex.ai)](https://developers.llamaindex.ai/docs/examples/memory/) | Data framework: memory abstractions (chat memory buffers, vector-store memory, graph memory), node parsers, and index structures over documents. Summarization/retrieval managed as index/query pipelines, not as a single compaction call. | Keeps an index over past context; retrieves relevant chunks instead of carrying full history. | Embedding + vector search per retrieval; index build upfront. | Mature OSS; note README shows 2026 focus shift toward parsing (LlamaParse/LiteParse). | **MIT** (standard for the repo; `[unverified]` from fetched snippet — badge check recommended). |
| 6 | **LLMLingua** | [LLMLingua paper (arXiv:2310.05736)](https://arxiv.org/abs/2310.05736) | Coarse-to-fine prompt compression: budget controller + token-level iterative compression + instruction-tuned alignment, dropping low-information tokens while preserving semantics. | Compresses prompts up to **20x** with little performance loss (GSM8K, BBH, ShareGPT, Arxiv-March23). | Requires a small LM to score token importance; adds a pre-pass before the main model call. | Peer-reviewed (EMNLP 2023 Findings); OSS code at aka.ms/LLMLingua. | OSS research code `[unverified]` — check the repo license before embedding. |
| 7 | **RAPTOR** | [RAPTOR paper (arXiv:2401.18059)](https://arxiv.org/abs/2401.18059) | Recursive abstractive processing: recursively embed, cluster, and summarize chunks into a tree of summaries; retrieve across abstraction levels at inference. | Keeps a summary tree; retrieval pulls the right level per query. | Heavy offline build (embeddings + clustering + summarization per level); inference is retrieval-cheap. | Strong published results: +20% absolute on QuALITY with GPT-4. | OSS reference implementation `[unverified]` for license. |
| 8 | **OpenAI Codex / Gemini long-context** | `[unverified]` — direct fetches of OpenAI/Gemini docs did not return usable content this session. | Generally: model-side large windows + optional server-side compaction (OpenAI Responses API `compact` / Codex session compaction) and Gemini implicit/explicit context caching with long-context handling. | Varies by product surface. | Varies. | First-party, production. | Proprietary. |

### Honest gaps
- **RECOMP, Selective Context, LongLLMLingua, Morph, Cepheus:** named in the task brief but not verified this session (search was down; guessed arXiv IDs resolved to unrelated papers, e.g. 2401.2000 → Abell 1240, 2401.18059 = RAPTOR not LongLLMLingua). Treat any claim about these as `[unverified]` until re-checked. LongLLMLingua is a follow-up to LLMLingua with question-aware compression — directionally similar, numbers not verified here.
- **2025–2026 OSS compaction libraries** (e.g. newer agent-framework summarizers): `[unverified]` this session for the same reason. Recommend a web-search pass once the DeepSeek key is fixed (Plugins > Built-in plugin settings > Web search).

---

## 2. Ranked recommendation for a DSH compaction plugin

**Context:** DSH runs long agent sessions in a Cordis plugin harness; the compaction plugin must be self-contained (no provider-side compaction available for arbitrary models), cheap, and reversible.

### #1 — Anthropic-style two-tier: cheap pruning first, summarization second (recommended)
Adopt the split Anthropic documented: **context editing for tool results / thinking traces + server-style summarization for conversation turns**. Why it wins here:
- Tool-result clearing is deterministic and free (no extra LLM call) and removes the bulk of token bloat in agent sessions.
- Summarization only fires on the remaining conversational text, at thresholds, so summarizer cost is paid rarely.
- The pattern is provider-agnostic: implementable in a plugin with any model as summarizer, unlike Anthropic's server-side compaction which only helps Claude API users.
- Tradeoff: you own the summary prompt and its failure modes (summary drift, lost detail). Mitigate with structured summary schema + keeping the last N turns verbatim.

### #2 — LangGraph-style checkpointed state + LlamaIndex-style retrieval fallback
Second choice if DSH sessions get much longer: persist full state to a checkpointer store (local file/SQLite), keep a summarized head in context, and add a vector index over evicted history for recall (RAPTOR/LLMLingua-style compression for the index layer). Why not first: more moving parts (store, embeddings, retrieval) than the plugin needs today; graduate to this when sessions routinely exceed ~200k tokens or need cross-session recall.
- LangGraph's MIT-licensed design is a proven reference; the README's durable-execution + interrupts model maps cleanly onto DSH's long-running agents. [LangGraph README](https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md)

### #3 — MemGPT/Letta-style paging (do not adopt as primary)
Elegant and fully general, but it makes the agent itself responsible for every paging decision — non-deterministic, extra round-trips per eviction, and hard to audit. Letta's Apache-2.0 platform is a good reference for tier naming (in-context/recall/archive) [MemGPT paper](https://arxiv.org/abs/2310.08560) [Letta on GitHub](https://github.com/letta-ai/letta), but as the core mechanism it trades away the predictability a compaction plugin should have.

**LLMLingua** [paper](https://arxiv.org/abs/2310.05736) is recommended as an **optional pre-compression layer** for summarizing very long docs before they enter context (20x compression is compelling for doc-ingest), not as the conversational compaction mechanism.

---

## 3. Proposed DSH compaction plugin architecture

```
                 ┌─────────────────────────────────────────────┐
                 │            DSH Compaction Plugin            │
                 └─────────────────────────────────────────────┘
  Session transcript
        │
        ▼
  ┌──────────────┐   Stage 1: PRUNE (always on, free)
  │ Token meter  │────────────► clear old tool results
  └──────┬───────┘              clear thinking/reasoning blocks
         │                      (keep: user text, last N turns verbatim)
         │ threshold (e.g. 70% of budget)
         ▼
  Stage 2: SUMMARIZE (threshold-triggered)
    - Structured summary (facts, decisions, open tasks, file paths)
    - Summarizer: cheapest/fastest model on route (pin + fallback)
    - Keep: summary + last N turns + pinned items (never summarize)
         │
         ▼
  Stage 3: SPILL (overflow)
    - Evicted raw history → spill store (local file/SQLite, checkpointer-style)
    - RAPTOR-lite index: chunk + embed spilled history for recall
    - Recall tool: search spilled history back into context when needed
         │
         ▼
  Stage 4: IMAGE / LARGE PAYLOAD OFFLOAD
    - Images & big tool outputs → offload to file store, keep a reference +
      caption in context; re-attach on demand
  Fallbacks:
    - Summarizer fails/timeouts → prune-only mode (Stage 1) + warn
    - Summary exceeds budget → LLMLingua-style token compression pass
    - Spill store full → oldest-first delete with log entry
```

**Stages & triggers**
1. **Prune** — runs every turn, no LLM call. Trigger: always, over tool results older than K turns (Anthropic's `clear_tool_uses` pattern [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing.md)).
2. **Summarize** — threshold-triggered at ~70% of the model's window (threshold mode in Anthropic's compaction doc [compaction.md](https://platform.claude.com/docs/en/build-with-claude/compaction.md)). Structured summary, not free prose.
3. **Spill** — on eviction, raw text goes to a local store (LangGraph checkpointer pattern [LangGraph README](https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md)); retrieval via chunk+embed (RAPTOR-lite, cheap at this scale [RAPTOR](https://arxiv.org/abs/2401.18059)).
4. **Image offload** — images and oversized payloads stored by reference; caption (alt-text model or filename) stays inline.

**Retention rules**
- Never summarize: system prompt, user-set pinned facts, last N turns verbatim, pending tool calls.
- Summaries are versioned and supersede each other (keep newest; older summaries archived to spill).
- Spilled history is append-only; deletion only on explicit store-full policy with logging.

**Summarizer choice**
- Default: cheapest capable model on the user's configured route (avoids a second provider/key).
- Fallback chain: primary route → secondary route → prune-only mode.
- Optional: LLMLingua-style compression for doc-ingest before summarization [LLMLingua](https://arxiv.org/abs/2310.05736).

**Why this shape:** it mirrors the split Anthropic validated in production (cheap editing + occasional summarization [compaction.md](https://platform.claude.com/docs/en/build-with-claude/compaction.md) [context-editing.md](https://platform.claude.com/docs/en/build-with-claude/context-editing.md)), uses LangGraph's checkpointing idea for durability [LangGraph README](https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md), and borrows MemGPT's tier vocabulary [MemGPT](https://arxiv.org/abs/2310.08560) without making the agent manage paging itself.

---

## 4. Sources

- Anthropic — Compaction: https://platform.claude.com/docs/en/build-with-claude/compaction.md
- Anthropic — Context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing.md
- MemGPT paper (arXiv:2310.08560): https://arxiv.org/abs/2310.08560
- Letta repo (Apache-2.0, via GitHub API): https://github.com/letta-ai/letta
- LangGraph README (MIT): https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md
- LlamaIndex README: https://raw.githubusercontent.com/run-llama/llama_index/main/README.md
- LLMLingua (arXiv:2310.05736): https://arxiv.org/abs/2310.05736
- RAPTOR (arXiv:2401.18059): https://arxiv.org/abs/2401.18059

**Everything not in the table above is marked `[unverified]`** and should be confirmed with a web-search pass once the DeepSeek search key is fixed.
