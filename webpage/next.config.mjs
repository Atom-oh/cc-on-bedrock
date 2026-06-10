/** @type {import('next').NextConfig} */
const nextConfig = {
  // GitHub Pages static export — atom-oh.github.io/cc-on-bedrock/
  output: 'export',
  basePath: '/cc-on-bedrock',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
