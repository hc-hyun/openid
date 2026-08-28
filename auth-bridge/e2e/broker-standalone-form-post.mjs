#!/usr/bin/env node

process.env.AUTHBRIDGE_E2E_RESPONSE_MODE = "form_post";
process.env.AUTHBRIDGE_E2E_STANDALONE = "true";
await import("./broker-query.mjs");
