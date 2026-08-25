# chardb landing

Project site for [chardb.dev](https://chardb.dev). Vite + React + TypeScript + Tailwind, deployed to Cloudflare Pages.

This package is a Bun workspace member of the repo root, so install from the repo root:

```bash
bun install            # at repo root
```

## Develop

```bash
cd landing && bun run dev
```

## Build

```bash
cd landing && bun run build
```

Output goes to `landing/dist/`.

## Deploy (Cloudflare Pages)

Manual deploy from local:

```bash
cd landing && bun run deploy
```

This runs `vite build` then `wrangler pages deploy dist --project-name chardb-landing`.

First-time setup:

1. `bunx wrangler login`
2. `bunx wrangler pages project create chardb-landing --production-branch main` (or create in dashboard).
3. After the first deploy, assign `chardb.dev` under the project's **Custom domains** in the Cloudflare dashboard.

Cloudflare Pages reads `landing/wrangler.toml` for project name and `pages_build_output_dir`.

## Social images / favicons

The OG image (`public/og.png`), favicon (`public/favicon-512.png`) and apple-touch-icon (`public/apple-touch-icon.png`) are rendered from real React components (`src/og/OgImage.tsx`, `src/og/Favicon.tsx`) via headless Chrome — so the live WebGL coal shader actually rasterizes into the PNGs.

Re-render after design changes:

```bash
cd landing && bun run og
```

Requires Google Chrome installed at `/Applications/Google Chrome.app` (the script uses `playwright-core` against system Chrome — no chromium download).

## Structure

- `src/components/` — UI components
- `src/components/sections/` — current proof and destination sections
- `src/components/CoalShader.tsx` — WebGL coal/ember shader for the hero
- `src/lib/constants.ts` — site URL, GitHub URL, repository setup command
- `tailwind.config.ts` — design tokens (ink, accent, syntax colors, fonts)
