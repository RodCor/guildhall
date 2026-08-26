#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { defaultConfigPath } from "./config.js";
import { createGuildNodeServer } from "./server.js";

const options = parseArguments(process.argv.slice(2));

serveStdio(
  () =>
    createGuildNodeServer({
      configPath: options.configPath,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    }),
  {
    onerror(error) {
      process.stderr.write(`Guild Node protocol error: ${error.message}\n`);
    },
  },
);

function parseArguments(arguments_: readonly string[]): {
  readonly configPath: string;
  readonly baseUrl?: string;
} {
  let configPath = defaultConfigPath();
  let baseUrl: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--config" && value !== undefined) {
      configPath = value;
      index += 1;
      continue;
    }
    if (argument === "--base-url" && value !== undefined) {
      baseUrl = value;
      index += 1;
      continue;
    }
    throw new TypeError(
      `Unknown or incomplete Guild Node argument: ${argument}`,
    );
  }
  return { configPath, ...(baseUrl === undefined ? {} : { baseUrl }) };
}
