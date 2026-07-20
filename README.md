# CodeMind — Track 1: MemoryAgent

Developer AI with persistent memory. Combines a SigMap-style structural index with a three-tier experiential memory system (hot / warm / cold).

## Run

```bash
cd codemind
cp .env.example .env
npm install
npm run build
npm start
```

## Files

- `src/qwenClient.ts` — Qwen Cloud OpenAI-compatible client
- `src/memory.ts` — memory tiers, SigMap simulator, consolidation
- `src/index.ts` — demo conversation showing Session 1 vs Session 3 improvement
