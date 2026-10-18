#!/usr/bin/env node
import { proxyFromEnv } from '../src/cli/client.ts';
import { main } from '../src/cli/main.ts';

proxyFromEnv();
process.exitCode = await main(process.argv.slice(2));
