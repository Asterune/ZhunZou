#!/usr/bin/env node
// The npm package ships the self-contained esbuild bundle so installing it
// never pulls @zhunzou/shared / MCP SDK / zod at runtime.
import '../dist-standalone/mcp.mjs';
