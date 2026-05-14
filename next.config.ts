import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Google's favicon service supplies the per-company logos in the
    // matches view's section headers. See lib/scan/logos.ts.
    remotePatterns: [
      { protocol: "https", hostname: "www.google.com" },
    ],
  },
};

export default nextConfig;
