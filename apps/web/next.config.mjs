/** @type {import('next').NextConfig} */
const nextConfig = {
  // Consume the shared Zod schemas / types / design tokens from source.
  transpilePackages: ["@snapcrawl/shared"],
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
