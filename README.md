# NEET Prep OS

Vite + React. Styles are precompiled Tailwind CSS in `src/index.css`.

## Build

```bash
npm install
npm run build
```

There is **no** `postcss.config.js`. The Vercel error `Cannot find module 'tailwindcss'` was caused by PostCSS loading the Tailwind plugin when the package was missing or omitted. The build no longer needs that module.

## Vercel

- Project root: this folder
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
