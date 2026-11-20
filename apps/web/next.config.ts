import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next compiles them for route handlers.
  transpilePackages: ["@daedalus/db", "@daedalus/core", "@daedalus/kit", "@daedalus/projects"],
  // Native module: load it from node_modules at runtime, never bundle it.
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
