import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";

test("Langfuse v5 adapter: root hierarchy, propagated session, generation usage/cost", async () => {
  // Import after supplying the unrelated required app key so this unit test
  // cannot accidentally configure or write to a real Langfuse project.
  process.env.OPENROUTER_API_KEY ??= "test-openrouter-key";
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  const { createTraceAdapter } = await import("../src/obs/langfuse.ts");

  const spans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export(batch, callback) {
      spans.push(...batch);
      callback({ code: 0 });
    },
    async shutdown() {},
  };
  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({ exporter, shouldExportSpan: () => true })],
  });
  sdk.start();

  const returnedTraceId = await propagateAttributes(
    {
      traceName: "bob-chat",
      userId: "user-test",
      sessionId: "session-test",
      tags: ["teams"],
      metadata: { channel: "teams" },
    },
    () =>
      startActiveObservation("bob-chat", async (root) => {
        root.update({ input: "hello" });
        const trace = createTraceAdapter(root);
        const child = trace.span("route");
        child.end({ category: "HR" });
        trace.generation({
          name: "router",
          model: "test-model",
          version: "v1",
          input: "hello",
          output: "HR",
          latencyMs: 25,
          usage: { input: 10, output: 2, total: 12, totalCost: 0.001 },
        });
        trace.update({ output: "answer", metadata: { category: "HR" }, tags: ["teams", "HR", "llm"] });
        return trace.traceId;
      }),
  );
  await sdk.shutdown();

  assert.equal(spans.length, 3);
  const root = spans.find((s) => s.name === "bob-chat");
  const route = spans.find((s) => s.name === "route");
  const generation = spans.find((s) => s.name === "router");
  assert.ok(root && route && generation);
  assert.equal(returnedTraceId, root.spanContext().traceId);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(route.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(generation.parentSpanContext?.spanId, root.spanContext().spanId);

  for (const span of spans) {
    assert.equal(span.attributes["user.id"], "user-test");
    assert.equal(span.attributes["session.id"], "session-test");
    assert.equal(span.attributes["langfuse.trace.name"], "bob-chat");
  }
  assert.equal(generation.attributes["langfuse.observation.type"], "generation");
  assert.equal(generation.attributes["langfuse.observation.usage_details"], '{"input":10,"output":2,"total":12}');
  assert.equal(generation.attributes["langfuse.observation.cost_details"], '{"total":0.001}');
  assert.equal(root.attributes["langfuse.observation.input"], "hello");
  assert.equal(root.attributes["langfuse.observation.output"], "answer");
  assert.equal(root.attributes["langfuse.trace.tags"], '["teams","HR","llm"]');
});
