import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

test("redacts credentials in structured fields and connection strings", () => {
  const input = { password: "private", nested: { accessToken: "private", sessionId:"private" }, message: "failed mongodb://private@host/db signing-value" };
  const output = JSON.stringify(redact(input,["signing-value"]));
  assert.doesNotMatch(output,/private|signing-value/);
  assert.match(output,/REDACTED/);
});
test("retains useful request metadata", () => {
  const input = { requestId:"test_42", status:503, route:"/products/:id" };
  assert.deepEqual(redact(input),input);
});
