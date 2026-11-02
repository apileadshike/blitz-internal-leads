import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a production build run next to `next dev` without touching its files (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Server-only packages: load them from node_modules at runtime instead of bundling.
  serverExternalPackages: ["blitz-api-js", "exceljs"],
};

export default nextConfig;
