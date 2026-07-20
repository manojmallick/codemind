import { QwenClient } from "./qwenClient";
import { CodeMindMemory, SigMapStore, MemoryEntry } from "./memory";

export class CodeMind {
  private client: QwenClient;
  private memory: CodeMindMemory;
  private sigmap: SigMapStore;

  constructor(apiKey?: string, memoryPath = "codemind_memory.json") {
    this.client = new QwenClient(apiKey);
    this.memory = new CodeMindMemory(memoryPath);
    this.sigmap = new SigMapStore();
  }

  loadRepo(signatures: Record<string, string>) {
    this.sigmap = new SigMapStore(signatures);
  }

  async chat(query: string) {
    const sigmapContext = this.sigmap.query(query);
    const memories = this.memory.relevant(query);
    const memoryContext =
      memories.map((m) => `- [${m.category}] ${m.content}`).join("\n") ||
      "(no relevant experiential memory yet)";

    const system = `You are CodeMind, a senior developer AI with persistent memory.

STRUCTURAL CONTEXT (from SigMap):
${sigmapContext}

EXPERIENTIAL MEMORY (from past sessions):
${memoryContext}

Answer grounded in BOTH sources. Cite files and past preferences when relevant.`;

    const answer = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: query },
      ],
      model: "qwen-max",
      temperature: 0.3,
    });

    const extracted = await this.extractMemories(query, answer);
    for (const m of extracted) {
      if (m.tier === "hot") m.tier = "warm";
      this.memory.add(m);
    }

    return {
      query,
      answer,
      sigmapContext,
      memoryContext,
      memoriesAdded: extracted.length,
    };
  }

  private async extractMemories(user: string, assistant: string): Promise<MemoryEntry[]> {
    const prompt = `From this developer-AI exchange, extract any preferences, corrections, conventions, file references, or facts worth remembering.

User: ${user}
Assistant: ${assistant}

Return JSON with a list:
{"memories": [{"content": "...", "category": "preference|correction|convention|fact", "tier": "hot|warm|cold", "confidence": 0.0-1.0, "sourceFile": "optional/path"}]}`;

    try {
      const result = await this.client.jsonChat<{ memories: MemoryEntry[] }>({
        messages: [{ role: "user", content: prompt }],
        model: "qwen-max",
        temperature: 0.1,
      });
      return result.memories || [];
    } catch (err) {
      console.error("Memory extraction failed:", err);
      return [];
    }
  }

  async consolidate() {
    await this.memory.consolidate(this.client);
  }
}

async function demo() {
  const cm = new CodeMind();
  cm.loadRepo({
    "src/services/PaymentService.java": "handleException(Exception e) -> ErrorResponse",
    "src/GlobalExceptionHandler.java": "@ControllerAdvice, returns ErrorResponse with HTTP status",
    "src/auth/JwtFilter.java": "validates JWT tokens, returns 401 on failure",
  });

  console.log("\n=== Session 1 ===");
  console.log((await cm.chat("How should I handle errors in this service?")).answer);

  console.log("\n=== Session 2 ===");
  console.log(
    (
      await cm.chat(
        "I prefer centralized error handling and ErrorResponse objects. Apply that to PaymentService."
      )
    ).answer
  );

  console.log("\n=== Session 3 (should remember preference) ===");
  console.log((await cm.chat("How should I handle errors in this service?")).answer);

  await cm.consolidate();
  console.log("\nMemory consolidated.");
}

if (require.main === module) {
  demo().catch(console.error);
}
