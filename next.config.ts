import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // These packages must run as native Node.js dependencies on the server, not be bundled.
  // mongodb is only imported from src/infrastructure/database and src/repositories;
  // argon2 (a native addon) is only imported from src/services.
  serverExternalPackages: ["mongodb", "argon2"],
};

export default nextConfig;
