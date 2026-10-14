// Generates a demo RSA key pair, the JWKS agentgateway uses to validate tokens,
// and one JWT per demo user.
//
//   alice -> groups: ["readonly"]
//   bob   -> groups: ["readwrite"]
//
// Usage: node scripts/gen-keys.mjs   (no dependencies, Node 18+)
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ISSUER = "mcp-acls-demo";
const AUDIENCE = "agentgateway-mcp";
const KID = "mcp-acls-demo-key";
const USERS = [
  { sub: "alice", groups: ["readonly"] },
  { sub: "bob", groups: ["readwrite"] },
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "agentgateway-config", "keys");
mkdirSync(outDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
writeFileSync(join(outDir, "jwks.json"), JSON.stringify({ keys: [jwk] }, null, 2));

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function sign(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = b64url({ iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 7 * 24 * 3600, ...claims });
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

for (const user of USERS) {
  const file = join(outDir, `${user.sub}.jwt`);
  writeFileSync(file, sign(user) + "\n");
  console.log(`wrote ${file}  (sub=${user.sub}, groups=${user.groups.join(",")})`);
}
console.log(`wrote ${join(outDir, "jwks.json")}`);
