import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58, newKeyPair } from "../src/register-agents.ts";
import { proposal } from "../src/lib.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("e2e --mock completes with all checks passing", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "run.ts"), "--mock"], { encoding: "utf8", cwd: join(here, "..") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All checks passed\./);
  assert.match(r.stdout, /vendor_not_allowlisted|not allowlisted/);
});

test("base58 and key generation produce NEAR-format keys", () => {
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
  const k = newKeyPair();
  assert.match(k.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.match(k.secretKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/);
});

test("proposal wraps args as base64 in a Sputnik FunctionCall", () => {
  const p = proposal("d", "bylaw.x.testnet", [{ method: "set_vendor", args: { vendor: "v.testnet", allowed: true } }]);
  const act = p.proposal.kind.FunctionCall.actions[0];
  assert.equal(act.method_name, "set_vendor");
  assert.deepEqual(JSON.parse(Buffer.from(act.args, "base64").toString()), { vendor: "v.testnet", allowed: true });
});
