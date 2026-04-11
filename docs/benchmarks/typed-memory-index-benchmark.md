# Memory Benchmark Report

**Environment:** NemoClaw sandbox container
**Tokenizer:** tiktoken cl100k_base (GPT-4 / Claude-class models)
**Branch:** `aniket/feat-typed-memory-index`

## How to Try It

Check out the `aniket/feat-typed-memory-index` branch, build the plugin (`cd nemoclaw && npm install && npm run build`), and rebuild your sandbox image (`podman build -t nemoclaw-production -f Dockerfile .`). Once your sandbox is running with the updated plugin, type `/nemoclaw memory enable` in the OpenClaw chat. That's it — the agent switches to the typed index, gains three memory tools (`nemoclaw_memory_save`, `nemoclaw_memory_read`, `nemoclaw_memory_search`), and starts saving ~59% of context tokens at scale. Typed memory is disabled by default; the agent uses OpenClaw's standard flat MEMORY.md until you opt in. To switch back, type `/nemoclaw memory disable` — topic files stay on disk, nothing is lost. To reproduce the benchmark numbers below, run `npm run benchmark:memory` (requires Podman).

## Context Window Tokens (Static Cost)

Tokens loaded into the agent's context at session start.

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           674 |                  337 |   50.0% |
|      50 |          3348 |                 1427 |   57.4% |
|     100 |          6689 |                 2789 |   58.3% |
|     500 |         33429 |                13689 |   59.1% |
|    1000 |         66854 |                27314 |   59.1% |
|    5000 |        334254 |               136314 |   59.2% |
|   10000 |        668504 |               272564 |   59.2% |

## Crossover Point

The typed index becomes smaller than the flat file at approximately **10 entries**.
Below this point, the index table header overhead makes the typed format larger.

## Total Session Tokens (Dynamic Cost)

Estimated total tokens per session, including tool call overhead.
Tool call overhead per read: ~80 tokens (request + response wrapper).
Average topic content: ~67 tokens.

### Agent reads 0 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           674 |                  337 |   50.0% |
|      50 |          3348 |                 1427 |   57.4% |
|     100 |          6689 |                 2789 |   58.3% |
|     500 |         33429 |                13689 |   59.1% |
|    1000 |         66854 |                27314 |   59.1% |
|    5000 |        334254 |               136314 |   59.2% |
|   10000 |        668504 |               272564 |   59.2% |

### Agent reads 3 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           674 |                  778 | +15.4% (more) |
|      50 |          3348 |                 1868 |   44.2% |
|     100 |          6689 |                 3230 |   51.7% |
|     500 |         33429 |                14130 |   57.7% |
|    1000 |         66854 |                27755 |   58.5% |
|    5000 |        334254 |               136755 |   59.1% |
|   10000 |        668504 |               273005 |   59.2% |

### Agent reads 5 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           674 |                 1072 | +59.1% (more) |
|      50 |          3348 |                 2162 |   35.4% |
|     100 |          6689 |                 3524 |   47.3% |
|     500 |         33429 |                14424 |   56.9% |
|    1000 |         66854 |                28049 |   58.0% |
|    5000 |        334254 |               137049 |   59.0% |
|   10000 |        668504 |               273299 |   59.1% |

### Agent reads 10 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           674 |                 1807 | +168.1% (more) |
|      50 |          3348 |                 2897 |   13.5% |
|     100 |          6689 |                 4259 |   36.3% |
|     500 |         33429 |                15159 |   54.7% |
|    1000 |         66854 |                28784 |   56.9% |
|    5000 |        334254 |               137784 |   58.8% |
|   10000 |        668504 |               274034 |   59.0% |

## Key Takeaways

1. **Context window savings:** At 1,000+ entries, the typed index saves ~59.1% of context tokens.
2. **Crossover:** Below ~10 entries, the flat format is more compact.
3. **Tool call cost:** Even reading 10 topics per session, the typed index uses fewer total tokens at 50+ entries.
4. **Scalability:** At 10,000 entries, the flat format consumes 668,504 tokens — the typed index uses 272,564 (59.2% less).

## How the Benchmark Works

The benchmark runs inside a Podman container using the compiled TypedMemoryProvider against a real filesystem. Token counts come from tiktoken cl100k_base (the same encoding used by GPT-4o and Claude-class models).

For each scale (10, 50, 100, 500, 1K, 5K, 10K entries), the benchmark does:

1. **Generate synthetic entries** — realistic memory content, 3-4 lines each (e.g., "Use VS Code with vim keybindings. Dark mode preferred. Installed extensions: ESLint, Prettier, GitLens..."). Twenty rotating topics across all four types (user, project, feedback, reference).

2. **Measure flat memory** — writes all entries as bullet points in a single MEMORY.md file. Counts tokens with tiktoken. This is what the agent loads into context with the default memory system — everything, every session.

3. **Measure typed index** — writes the same entries via `TypedMemoryProvider`, which creates an index table in MEMORY.md and individual topic files under `memory/topics/`. Counts tokens in the index table only (not the topic files). This is what the agent loads with the typed index — just titles, types, and dates.

4. **Record the savings** — compares flat tokens vs index tokens at this scale.

5. **Clean up and repeat** — deletes the temp directory, moves to the next scale.

6. **Calculate session costs** — for each scale, estimates total tokens the agent uses in a realistic session. This accounts for the fact that the typed index agent doesn't just load the index — it also reads topics on demand, and each read costs tokens (see rationale below).

7. **Find the crossover point** — binary searches for the exact entry count where the typed index becomes smaller than the flat file.

8. **Output the report** — writes the markdown tables, crossover analysis, session costs, and takeaways.

### Session Cost Rationale

The "Total Session Tokens" tables model what actually happens in a session:

**Flat memory:** The agent loads the entire MEMORY.md into context. Total cost = all tokens in the file. There are no tool calls because everything is already in context.

**Typed index:** The agent loads only the index table into context, then reads individual topics on demand using the `nemoclaw_memory_read` tool. Each tool call has overhead:

- The agent sends a tool call request (~30 tokens for the function name, parameters, and framing)
- The tool executes and returns the topic content
- The result is wrapped in tool response framing (~50 tokens)
- Total overhead per read: ~80 tokens (on top of the actual topic content)

So the formula is:

```text
typed_session_tokens = index_tokens + K × (avg_topic_tokens + 80)
```

Where K is the number of topics the agent reads in a session. We test K = 0 (agent doesn't read any topics), K = 3 (light usage), K = 5 (moderate), and K = 10 (heavy usage).

**Why this matters:** The typed index saves tokens on context loading but spends tokens on tool calls. At small scale with heavy reads (e.g., 10 entries, K=10), the tool call overhead exceeds the savings — the flat file would have been cheaper. At larger scale (50+ entries), the context savings dominate even under heavy read patterns.

The 80-token overhead is an estimate based on typical OpenAI/Anthropic tool call framing. The exact number varies by model, but the ratios hold.
