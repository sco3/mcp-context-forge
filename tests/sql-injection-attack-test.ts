#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PAYLOADS = ["DROP table asdf", "truncate table asdf"];
const t = new StreamableHTTPClientTransport(new URL("http://localhost:4444/servers/9779b6698cbd4b4995ee04a4fab38737/mcp"), {
  fetch: (u, i = {}) => {
    const h = new Headers(i.headers as HeadersInit);
    h.set("Authorization", `Bearer ${process.env.TOKEN}`);
    return fetch(u, { ...i, headers: h });
  }
});

const c = new Client({ name: "test", version: "1.0" }, { capabilities: {} });

c.connect(t).then(async () => {
  let passed = 0, failed = 0;
  for (const payload of PAYLOADS) {
    const r = await c.callTool({ name: "fast-time-echo", arguments: { message: payload } });
    console.log(`\nPayload: "${payload}"`);
    console.log("Response:", JSON.stringify(r, null, 2));
    if (r.isError && r.content?.[0]?.text?.includes("blocked by plugin SQLSanitizer")) {
      console.log(`✓ BLOCKED: ${payload}`);
      passed++;
    } else {
      console.error(`✗ BYPASS: ${payload}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("All sql-sanitizer tests passed!");
  await t.close();
}).catch(e => { console.error("Error:", e); process.exit(1); });
