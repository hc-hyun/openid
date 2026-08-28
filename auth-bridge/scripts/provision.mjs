#!/usr/bin/env node

import { loadConfig } from "../lib/config.mjs";
import { provision } from "../lib/keycloak-admin.mjs";
import { safeErrorMessage } from "../lib/redact.mjs";

try {
  const config = await loadConfig();
  console.log(`AuthBridge callback: ${config.callbackUrl}`);
  const result = await provision(config);
  console.log(`AuthBridge realm ready: ${result.realm}`);
  console.log(`CLI issuer: ${config.keycloak.publicUrl}/realms/${result.realm}`);
} catch (error) {
  console.error(`Provisioning failed: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
}
