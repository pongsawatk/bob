// Quick pipeline test — loads .env then calls runPipeline with a sample HR question.
// Usage: node scripts/test-pipeline.mjs [question]
//   e.g. node scripts/test-pipeline.mjs "ลาพักร้อนต้องทำยังไง"
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const question = process.argv[2] || "ลาพักร้อนต้องทำยังไง";

console.log("BOB Pipeline Test");
console.log("─".repeat(48));
console.log("question:", question);
console.log("─".repeat(48));

// Dynamic import after env is set
const { runPipeline } = await import("../src/pipeline/index.ts");

try {
  const result = await runPipeline({
    message: question,
    userId: "test-jor",
    userName: "Jor",
    department: "Contech BU",
  });

  console.log("category:", result.category);
  console.log("latency: ", result.latencyMs + "ms");
  console.log("cache:   ", result.fromCache);
  console.log("tokens:  ", JSON.stringify(result.usage));
  console.log("─".repeat(48));
  console.log(result.answer);
} catch (err) {
  console.error("ERROR:", err?.message ?? err);
  process.exit(1);
}
