import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueMongoMembers, type MongoServerDescription } from "./mongo-members.ts";

const members = (...rows: MongoServerDescription[]) => new Map(rows.map((row, i) => [String(i), row]));

test("keeps different replica-set hosts sharing the same port", () => {
  const result = uniqueMongoMembers(members(
    { address: "mongo-a:27017", type: "RSPrimary" },
    { address: "mongo-b:27017", type: "RSSecondary" },
    { address: "mongo-c:27017", type: "Unknown" },
  ));
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(row => row.address), ["mongo-a:27017", "mongo-b:27017", "mongo-c:27017"]);
});

test("deduplicates only the equivalent local endpoint alias", () => {
  const result = uniqueMongoMembers(members(
    { address: "127.0.0.1:27017", type: "Unknown" },
    { address: "host.docker.internal:27017", type: "RSPrimary" },
    { address: "host.docker.internal:27018", type: "RSSecondary" },
  ));
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "RSPrimary");
});

test("does not collapse IPv6 members or similarly named hosts", () => {
  assert.equal(uniqueMongoMembers(members(
    { address: "[::1]:27017", type: "RSPrimary" },
    { address: "[::2]:27017", type: "RSSecondary" },
    { address: "host.docker.internal.other:27017", type: "RSSecondary" },
  )).length, 3);
});
