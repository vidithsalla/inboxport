import { randomBytes } from "node:crypto";

const key = () => randomBytes(32).toString("base64url");

process.stdout.write([
  `RELAY_COOKIE_KEY=${key()}`,
  `RELAY_VAULT_KEK=${key()}`,
  "",
].join("\n"));
