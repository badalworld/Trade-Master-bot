import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A trading bot must not ship past a lint failure; the previous setting silently skipped it.
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    // Framing is denied by default. A deployment that genuinely needs this page inside a shell
    // (an embedded console, a hosted preview pane) can opt in explicitly with
    // `TM_FRAME_ANCESTORS="https://console.example.com"` — a deliberate relaxation, not an
    // accidental one, and it never falls back to "allow everything".
    // Next.js evaluates `headers()` during `next build` and bakes the result into
    // `.next/routes-manifest.json`, so this is a *build-time* knob: changing it means rebuilding.
    const frameAncestors = (process.env.TM_FRAME_ANCESTORS || '').trim() || "'none'";
    const framingHeaders =
      frameAncestors === "'none'"
        ? [
            // `frame-ancestors` is the modern control; `X-Frame-Options` covers older clients.
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          ]
        : [
            // X-Frame-Options cannot express an allowlist (its only non-DENY value, ALLOW-FROM, is
            // ignored by modern browsers), so with an explicit allowlist the CSP control carries it.
            { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` },
          ];

    return [
      {
        // This app can hold a credential-bearing session cookie, so it gets explicit isolation.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // This page drives real orders, so it must not be framed by another site: clickjacking a
          // "START BOT" / "Close position" button is a real path to a real loss. Consequence:
          // embedding this app inside another page is blocked by default — put the shell behind the
          // operator session and link out, or name the embedding origin in `TM_FRAME_ANCESTORS`.
          ...framingHeaders,
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
        ],
      },
      {
        source: '/api/binance/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },

  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
