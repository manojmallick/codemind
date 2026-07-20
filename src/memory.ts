import fs from "fs";
import { QwenClient } from "./qwenClient";

export interface MemoryEntry {
  content: string;
  category: "preference" | "correction" | "convention" | "fact";
  tier: "hot" | "warm" | "cold";
  confidence: number;
  timestamp: number;
  decayRate: number;
  sourceFile?: string;
  hits: number;
}

function relevanceScore(entry: MemoryEntry, query: string, now = Date.now()): number {
  const ageDays = Math.max(0, (now - entry.timestamp) / 86400000);
  const decay = Math.max(0.1, 1 - entry.decayRate * ageDays);
  const qWords = query.toLowerCase().split(/\s+/);
  const overlap = qWords.filter((w) =>
    entry.content.toLowerCase().includes(w)
  ).length;
  const overlapScore = Math.min(1, overlap / Math.max(1, qWords.length));
  return (
    entry.confidence * decay * 0.6 +
    overlapScore * 0.3 +
    (Math.min(entry.hits, 10) / 10) * 0.1
  );
}

export class SigMapStore {
  constructor(private signatures: Record<string, string> = {}) {}

  query(query: string, topK = 5): string {
    const qWords = new Set(query.toLowerCase().split(/\s+/));
    const qFragments = new Set(
      Array.from(qWords).flatMap((q) =>
        [q, q.slice(0, 4), q.slice(0, 5)].filter((f) => f.length >= 3)
      )
    );

    const scored = Object.entries(this.signatures)
      .map(([file, sig]) => {
        const corpus = (file + " " + sig).toLowerCase();
        const corpusWords = new Set(corpus.split(/\s+/));
        const exact = Array.from(qWords).filter((w) => corpusWords.has(w)).length;
        const tokens = file
          .replace(/[\/.]/g, " ")
          .replace(/_/g, " ")
          .toLowerCase()
          .split(/\s+/);
        let substring = 0;
        for (const frag of qFragments) {
          for (const token of tokens) {
            if (token.includes(frag)) substring += 1;
          }
        }
        return { file, sig, score: exact + substring * 0.3 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.length
      ? scored.map((s) => `File: ${s.file}\nSignatures:\n${s.sig}`).join("\n\n")
      : "(no relevant signatures found)";
  }
}

export class CodeMindMemory {
  private hot: MemoryEntry[] = [];
  private warm: MemoryEntry[] = [];
  private cold: MemoryEntry[] = [];

  constructor(private storagePath = "codemind_memory.json") {
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.storagePath)) return;
    const data = JSON.parse(fs.readFileSync(this.storagePath, "utf-8"));
    this.hot = data.hot || [];
    this.warm = data.warm || [];
    this.cold = data.cold || [];
  }

  save() {
    const data = { hot: this.hot, warm: this.warm, cold: this.cold };
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
  }

  add(entry: MemoryEntry) {
    if (entry.tier === "hot") {
      this.hot.push(entry);
      this.hot = this.hot.slice(-10);
    } else if (entry.tier === "warm") {
      this.warm.push(entry);
    } else {
      this.cold.push(entry);
    }
    this.save();
  }

  relevant(query: string, topK = 8): MemoryEntry[] {
    const now = Date.now();
    const all = [...this.cold, ...this.warm, ...this.hot];
    const ranked = all
      .map((e) => ({ e, score: relevanceScore(e, query, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => {
        r.e.hits += 1;
        return r.e;
      });
    this.save();
    return ranked;
  }

  async consolidate(client: QwenClient) {
    if (this.warm.length === 0) return;
    const warmText = this.warm
      .map(
        (e) =>
          `- ${e.content} [confidence ${e.confidence.toFixed(2)}, hits ${e.hits}]`
      )
      .join("\n");

    const prompt = `Review these warm memories and classify each as one of: KEEP_WARM, PROMOTE_COLD, DISCARD.

Memories:
${warmText}

Return JSON: {"decisions": [{"content": "...", "action": "KEEP_WARM|PROMOTE_COLD|DISCARD"}]}`;

    try {
      const result = await client.jsonChat<{ decisions: Array<{ content: string; action: string }> }>({
        messages: [{ role: "user", content: prompt }],
        model: "qwen-max",
        temperature: 0.1,
      });

      for (const d of result.decisions || []) {
        const idx = this.warm.findIndex((e) => e.content === d.content);
        if (idx === -1) continue;
        const [entry] = this.warm.splice(idx, 1);
        if (d.action === "PROMOTE_COLD") {
          entry.tier = "cold";
          entry.confidence = 0.95;
          entry.decayRate = 0;
          this.cold.push(entry);
        } else if (d.action === "KEEP_WARM") {
          entry.confidence = Math.min(0.95, entry.confidence + 0.1);
          this.warm.push(entry);
        }
      }
      this.save();
    } catch (err) {
      console.error("Memory consolidation failed:", err);
    }
  }
}
