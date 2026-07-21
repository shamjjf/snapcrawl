/** @type {import('next').NextConfig} */
const nextConfig = {
  // Consume the shared Zod schemas / types / design tokens from source.
  transpilePackages: ["@snapcrawl/shared"],
  // Same-origin API proxy: with NEXT_PUBLIC_API_URL="" the browser calls
  // /api/v1/* on the panel's own origin and this rewrite forwards it to the
  // API server — one public domain, no CORS (used by Dockerfile.all deploys).
  // Destination is baked at build time; API_PROXY_URL overrides it.
  async rewrites() {
    const api = process.env.API_PROXY_URL ?? "http://localhost:4000";
    return [{ source: "/api/v1/:path*", destination: `${api}/api/v1/:path*` }];
  },
  // The shared package uses NodeNext-style `.js` import specifiers that resolve
  // to `.ts` source files. webpack's extensionAlias remaps them; Turbopack has
  // no equivalent for explicit `.js`→`.ts` remapping today, so the panel builds
  // with webpack (see the `--webpack` flag in package.json scripts).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
