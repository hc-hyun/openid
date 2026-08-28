#!/usr/bin/env node

process.env.AUTHBRIDGE_E2E_RESPONSE_MODE = "form_post";
await import("./broker-query.mjs");
