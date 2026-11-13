import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeConfig } from "../../lib/relay/config.ts";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("RELAY_DEMO_MODE=true is refused unless NODE_ENV is development", () => {
  withEnv({ RELAY_DEMO_MODE: "true", NODE_ENV: "production" }, () => {
    assert.throws(() => getRuntimeConfig(), /RELAY_DEMO_MODE=true is refused/);
  });
  withEnv({ RELAY_DEMO_MODE: "true", NODE_ENV: "test" }, () => {
    assert.throws(() => getRuntimeConfig(), /RELAY_DEMO_MODE=true is refused/);
  });
});

test("RELAY_DEMO_MODE=true is allowed when NODE_ENV is development", () => {
  withEnv({
    RELAY_DEMO_MODE: "true",
    RELAY_APP_URL: "http://127.0.0.1:3000",
    NODE_ENV: "development",
  }, () => {
    assert.equal(getRuntimeConfig().demoMode, true);
  });
});

test("RELAY_DEMO_MODE=true is refused on a non-loopback development URL", () => {
  withEnv({
    RELAY_DEMO_MODE: "true",
    RELAY_APP_URL: "https://preview.example.com",
    NODE_ENV: "development",
  }, () => {
    assert.throws(() => getRuntimeConfig(), /RELAY_DEMO_MODE=true is refused/);
  });
});

test("RELAY_DEMO_MODE unset or false never throws regardless of NODE_ENV", () => {
  withEnv({ RELAY_DEMO_MODE: undefined, NODE_ENV: "production" }, () => {
    assert.equal(getRuntimeConfig().demoMode, false);
  });
  withEnv({ RELAY_DEMO_MODE: "false", NODE_ENV: "production" }, () => {
    assert.equal(getRuntimeConfig().demoMode, false);
  });
});
