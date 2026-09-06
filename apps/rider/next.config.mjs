/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The PWA is a pure client of the API; no server-side data fetching here.
  output: "standalone",
};

export default nextConfig;
