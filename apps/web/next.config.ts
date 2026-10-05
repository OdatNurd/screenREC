import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image
  output: "standalone",
  experimental: {
    // Next's proxy buffers request bodies in memory (10MB default). Recording
    // uploads go through the /api rewrite below, so match nginx (512m) and the
    // API's multer limit (500MB) or large recordings get truncated mid-upload.
    proxyClientMaxBodySize: "512mb",
  },
  // Trace files from the monorepo root so the standalone bundle is complete
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Proxy /api to the local Express API so same-origin calls work without
  // nginx (local dev and bare `next start`). In the container, nginx handles
  // /api before requests reach Next, so this rewrite stays dormant there.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_PROXY_TARGET || "http://127.0.0.1:3001"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
