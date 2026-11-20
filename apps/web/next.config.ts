import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Route handlers reach the database and workspace packages only through the services
  // object that server.ts builds (src/services.ts), so nothing here needs bundling.
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
