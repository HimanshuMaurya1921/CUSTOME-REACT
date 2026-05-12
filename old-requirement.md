# React Pre-Render POC — Technical Design Document

**Author:** Senior System Design & React Engineer  
**Status:** R&D / Pre-Implementation  
**Goal:** Build a custom Vite plugin that pre-renders React routes into fully self-contained HTML files (inlined JS + CSS, no external assets)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Architecture Overview](#2-architecture-overview)
3. [Folder Structure](#3-folder-structure)
4. [Phase 1 — Project Setup](#4-phase-1-project-setup)
5. [Phase 2 — Route Discovery](#5-phase-2-route-discovery)
6. [Phase 3 — Vite Build with Per-Route Chunking](#6-phase-3-vite-build-with-per-route-chunking)
7. [Phase 4 — Pre-rendering (renderToStaticMarkup)](#7-phase-4-pre-rendering-rendertostaticmarkup)
8. [Phase 5 — Asset Inlining](#8-phase-5-asset-inlining)
9. [Phase 6 — Hydration (Optional, Per-Route)](#9-phase-6-hydration-optional-per-route)
10. [Phase 7 — The Vite Plugin (Putting It All Together)](#10-phase-7-the-vite-plugin-putting-it-all-together)
11. [Dynamic Imports — Handling Strategy](#11-dynamic-imports-handling-strategy)
12. [CDN Externals — Avoiding Fat HTML](#12-cdn-externals-avoiding-fat-html)
13. [File Size Analysis](#13-file-size-analysis)
14. [Testing Strategy](#14-testing-strategy)
15. [Known Limitations & Tradeoffs](#15-known-limitations-tradeoffs)
16. [Implementation Checklist](#16-implementation-checklist)

---

## 1. Problem Statement

Standard Vite/CRA React builds produce:

```
dist/
  index.html          ← single shell with <div id="root"></div>
  assets/main-abc.js  ← entire app bundle
  assets/main-xyz.css ← entire app stylesheet
```

This is a Single Page Application (SPA). All routes share one HTML entry point. JS handles routing in the browser.

**What we want instead:**

```
dist/
  index.html          ← route: /
  about.html          ← route: /about
  contact.html        ← route: /contact
  blog.html           ← route: /blog
```

Each file must be:
- **Self-contained** — no external `.js` or `.css` files referenced
- **Pre-rendered** — actual HTML content, not `<div id="root"></div>`
- **Scoped** — only ships JS/CSS that its own route needs

This is a **Multi-Page Application (MPA)** with React as the build-time rendering engine.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   BUILD PIPELINE                        │
│                                                         │
│  [1] Route Config          routes.config.js             │
│        ↓                                                │
│  [2] Vite Build            per-route entry points       │
│      (modified)            → chunk splitting            │
│        ↓                                                │
│  [3] Pre-Renderer          Node.js + renderToString     │
│                            visits each route            │
│        ↓                                                │
│  [4] Asset Inliner         reads chunk JS + CSS         │
│                            injects into HTML            │
│        ↓                                                │
│  [5] Output                dist/about.html (standalone) │
│                            dist/blog.html  (standalone) │
└─────────────────────────────────────────────────────────┘
```

### Core Technologies

| Tool | Role |
|---|---|
| **Vite** | Bundler + dev server |
| **Rollup** (via Vite) | Per-route code splitting |
| **React DOM Server** | `renderToStaticMarkup` / `renderToString` |
| **Node.js** | Build script runtime |
| **Custom Vite Plugin** | Orchestrates everything above |

---

## 3. Folder Structure

```
my-app/
├── src/
│   ├── routes/
│   │   ├── index.jsx          ← HomePage component
│   │   ├── about.jsx          ← AboutPage component
│   │   ├── contact.jsx        ← ContactPage component
│   │   └── blog.jsx           ← BlogPage component
│   ├── components/            ← shared components
│   ├── styles/                ← shared styles
│   └── routes.config.js       ← THE source of truth for routes
│
├── vite.config.js             ← plugin registered here
├── plugin/
│   └── vite-plugin-prerender.js   ← our custom plugin
│
├── scripts/
│   └── prerender.js           ← standalone pre-render script (Node)
│
└── dist/                      ← output (all self-contained HTML)
    ├── index.html
    ├── about.html
    ├── contact.html
    └── blog.html
```

---

## 4. Phase 1 — Project Setup

### 4.1 Base Vite + React Project

```bash
npm create vite@latest my-prerender-app -- --template react
cd my-prerender-app
npm install
```

> `react` and `react-dom` are already included by the `--template react` scaffold. No manual install needed.

### 4.2 Additional Dependencies

```bash
# react-dom/server is part of react-dom (already installed above)
# No separate install needed — just import from 'react-dom/server'

# For the build script (already available in Node 18+)
# No extra deps needed for fs, path, url

# Optional: for CSS extraction analysis
npm install -D rollup-plugin-css-only
```

### 4.3 routes.config.js

This is the **single source of truth**. The plugin reads this. The router reads this. One file, no duplication.

```js
// src/routes.config.js

const routes = [
  {
    path: '/',
    name: 'index',
    component: './routes/index.jsx',
    hydrate: false,        // static only — no React runtime shipped
    title: 'Home',
    meta: {
      description: 'Welcome to our site'
    }
  },
  {
    path: '/about',
    name: 'about',
    component: './routes/about.jsx',
    hydrate: false,
    title: 'About Us',
    meta: {
      description: 'Learn about us'
    }
  },
  {
    path: '/contact',
    name: 'contact',
    component: './routes/contact.jsx',
    hydrate: true,         // has a form — needs React interactivity
    title: 'Contact',
    meta: {
      description: 'Get in touch'
    }
  },
  {
    path: '/blog',
    name: 'blog',
    component: './routes/blog.jsx',
    hydrate: false,
    title: 'Blog',
    meta: {
      description: 'Read our blog'
    }
  }
]

export default routes
```

---

## 5. Phase 2 — Route Discovery

The plugin reads `routes.config.js` at build start and derives:

1. **Entry points** for Rollup (one per route)
2. **Output filenames** (`about.html`, etc.)
3. **Hydration flags** (does this route need React runtime?)

```js
// plugin/vite-plugin-prerender.js  (route discovery portion)

import routes from '../src/routes.config.js'

function discoverRoutes() {
  return routes.map(route => ({
    path: route.path,
    name: route.name,                          // "about"
    outputFile: `${route.name}.html`,          // "about.html"
    entryPoint: `src/routes/${route.name}.jsx`,// Rollup entry
    hydrate: route.hydrate ?? false,
    title: route.title,
    meta: route.meta ?? {}
  }))
}
```

**Why not file-system scanning?**  
File-system routing (Next.js style) is convenient but opaque. Explicit config is boring, obvious, and debuggable. When the build breaks at 2am, you want obvious.

---

## 6. Phase 3 — Vite Build with Per-Route Chunking

### 6.1 The Problem with Default Vite Build

Default Vite produces one entry: `index.html → main.jsx → everything`.

We need Rollup to treat each route as a **separate entry point** so it can tree-shake independently.

### 6.2 Modified vite.config.js

```js
// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { prerenderPlugin } from './plugin/vite-plugin-prerender.js'
import routes from './src/routes.config.js'

// Build per-route entry map for Rollup
const routeEntries = Object.fromEntries(
  routes.map(r => [
    r.name,                           // chunk name: "about"
    `./src/routes/${r.name}.jsx`      // entry file
  ])
)

export default defineConfig({
  plugins: [
    react(),
    prerenderPlugin()  // our plugin runs after build
  ],
  build: {
    rollupOptions: {
      input: routeEntries,
      output: {
        format: 'iife',               // REQUIRED: IIFE is self-contained (no imports)
        name: 'app',                  // Global name for the IIFE bundle
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-chunk.js',
        assetFileNames: 'assets/[name].[ext]',

        // REQUIRED for IIFE: flattening all code into the entry point
        inlineDynamicImports: true, 
      }
    },
    // Inline assets smaller than this threshold (in bytes)
    // Set to 0 to disable automatic inlining (we handle it manually)
    assetsInlineLimit: 0,

    // Keep CSS separate per chunk so we can read and inline it ourselves
    cssCodeSplit: true,
  }
})
```

### 6.3 What Rollup Produces

After this build, `dist/assets/` contains:

```
dist/
  assets/
    index.js              ← self-contained IIFE (HomePage + React)
    index.css             ← only CSS used by HomePage
    about.js              ← self-contained IIFE (AboutPage + React)
    about.css             ← only CSS used by AboutPage
    contact.js            ← self-contained IIFE (ContactPage + React)
    contact.css           ← only CSS used by ContactPage
    blog.js               ← self-contained IIFE (BlogPage + React)
    blog.css              ← only CSS used by BlogPage
```

---

## 7. Phase 4 — Pre-rendering (renderToStaticMarkup)

### 7.1 Two Rendering Modes

```
renderToStaticMarkup()   →  Pure HTML, no React attributes
                             Zero JS needed at runtime
                             Used for: static routes (hydrate: false)

renderToString()         →  HTML with data-reactroot attributes
                             React can "hydrate" this in the browser
                             Used for: interactive routes (hydrate: true)
```

### 7.2 Pre-render Script

This runs in **Node.js** after Vite build completes.

```js
// scripts/prerender.js

import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { createElement } from 'react'
import fs from 'fs'
import path from 'path'

async function prerenderRoute(route) {
  // Import from the SSR build output (dist-ssr/), NOT from dist/assets/
  // dist-ssr/ is produced INTERNALLY by the Vite plugin during build
  // It outputs Node-safe modules with no browser globals
  const modulePath = path.resolve('../dist-ssr', `${route.name}.js`)
  const module = await import(modulePath)
  const Component = module.default

  let html
  if (route.hydrate) {
    // renderToString: adds hydration markers React needs on the client
    html = renderToString(createElement(Component))
  } else {
    // renderToStaticMarkup: pure HTML, no React attributes, zero runtime JS
    html = renderToStaticMarkup(createElement(Component))
  }

  return html
}
```

### 7.3 HTML Template Builder

```js
// NOTE: routeName param removed — we use route.name directly.
// inlineJs contains the self-contained IIFE bundle (Route + React).
// No "stitching" of vendor code is needed.
// Hydration logic is handled internally by the route entry point
// (guarded by if (typeof window !== 'undefined')).

function buildHtmlTemplate({ renderedHtml, inlineJs, inlineCss, route }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${route.meta?.description ?? ''}" />
  <title>${route.title}</title>
  <style>
${inlineCss}
  </style>
</head>
<body>
  <div id="root">${renderedHtml}</div>
${route.hydrate
  ? `<script>\n${inlineJs}\n</script>`
  : '<!-- static page: no JS shipped -->'
}
</body>
</html>`
}
```

> **Why no `type="module"`?** Since we use the `iife` format, the script is a plain, self-contained JavaScript execution block. This avoids issues with ESM `import` statements which cannot resolve inside an inline script without a complex mapping.

> **Where does `inlineJs` come from?** It is captured by the Vite plugin during the `generateBundle` hook. Because we set `inlineDynamicImports: true`, each route's JS chunk already includes all its dependencies (including React).

### 7.4 Why Not Puppeteer?

Puppeteer (headless Chrome) is an alternative: spin up a browser, visit each route URL, snapshot the HTML.

| | `renderToStaticMarkup` | Puppeteer |
|---|---|---|
| Speed | Fast (pure Node) | Slow (Chrome startup per route) |
| Accuracy | Exact React output | Exact browser output |
| JS execution | No | Yes (runs all effects) |
| Setup complexity | Low | High |
| useEffect data | Not captured | Captured |
| External API calls | Not made | Made (risky in build) |

**Decision: Use `renderToString` / `renderToStaticMarkup`.**  
Puppeteer is overkill for static sites. It also means your build is making real HTTP requests, which is a terrible idea in CI/CD.

---

## 8. Phase 5 — Asset Inlining

### 8.1 Two Sources, Two Purposes

The standalone script (`scripts/prerender.js`) reads from **two separate locations**:

| Source | Contains | Used for |
|---|---|---|
| `dist-ssr/` | Node-safe CJS component modules | `renderToStaticMarkup` / `renderToString` |
| `dist/assets/` | Browser-targeted JS + CSS bundles | Inlining into final HTML |

These are produced by two separate builds — the plugin orchestrates both. The Vite plugin reads assets directly from `routeChunkMap` (in-memory, captured in `generateBundle`) rather than re-reading from disk.

```js
// scripts/prerender.js  (inlining portion)
// NOTE: This standalone script reads from dist/assets/ on disk.
// The Vite plugin (plugin/vite-plugin-prerender.js) reads from
// routeChunkMap (in-memory) instead — no filesystem reads needed there.

import fs from 'fs'
import path from 'path'

function readAsset(distDir, filename) {
  const filepath = path.join(distDir, 'assets', filename)
  if (!fs.existsSync(filepath)) return ''
  return fs.readFileSync(filepath, 'utf-8')
}

async function inlineAssetsForRoute(route, distDir) {
  // Read this route's specific JS chunk (already contains React due to inlineDynamicImports)
  const routeJs = readAsset(distDir, `${route.name}.js`)

  const inlineJs = route.hydrate
    ? routeJs
    : ''   // static pages ship zero JS

  // Read CSS
  const inlineCss = readAsset(distDir, `${route.name}.css`)

  return { inlineJs, inlineCss }
}
```

### 8.2 Note on Shared Code
With `inlineDynamicImports: true`, shared code like React is duplicated into each route's HTML file. While this increases total project size on disk, it ensures each HTML file is 100% independent and works perfectly when opened in isolation.

---

## 9. Phase 6 — Hydration (Optional, Per-Route)

Only routes with `hydrate: true` in the config get this treatment.

### 9.1 Full Hydration Flow

```
BUILD TIME:                          BROWSER TIME:
───────────────                      ────────────────────────────────
renderToString(<ContactPage />)  →   HTML renders instantly (0ms)
                                     Inlined IIFE executes
                                     hydrateRoot() called
                                     React walks DOM, attaches handlers
                                     Form is now interactive
```

---

## 10. Phase 7 — The Vite Plugin (Putting It All Together)

### 10.1 Plugin Lifecycle Hooks Used

| Vite Hook | When | What We Do |
|---|---|---|
| `configResolved` | After config merge | Read route config, validate |
| `buildStart` | Build begins | Log route discovery |
| `generateBundle` | After Rollup chunks built | Access chunk metadata |
| `closeBundle` | Build complete | Run pre-render + inline pipeline |

### 10.2 Plugin Skeleton

```js
// plugin/vite-plugin-prerender.js

import fs from 'fs'
import path from 'path'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { createElement } from 'react'

export function prerenderPlugin() {
  let resolvedConfig
  let routeChunkMap = {}   // { 'about': { js: '...', css: '...' } }

  return {
    name: 'vite-plugin-prerender',
    enforce: 'post',  // run after all other plugins

    // Step 1: Config is ready
    configResolved(config) {
      resolvedConfig = config
    },

    // Step 2: Capture chunk info BEFORE they're written to disk
    generateBundle(options, bundle) {
      for (const [filename, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          const routeName = chunk.name  // "about", "blog", etc.
          routeChunkMap[routeName] = {
            jsFilename: filename,  // "assets/about.js"
            code: chunk.code,      // actual JS source
          }
        }
        // Capture CSS files
        if (chunk.type === 'asset' && filename.endsWith('.css')) {
          const baseName = path.basename(filename, '.css')  // "about"
          if (!routeChunkMap[baseName]) routeChunkMap[baseName] = {}
          routeChunkMap[baseName].css = chunk.source
        }
      }
    },

    // Step 3: After build — run pre-render pipeline
    async closeBundle() {
      const { build } = await import('vite')
      const routes = (await import('../src/routes.config.js')).default
      const distDir = path.resolve(resolvedConfig.root, 'dist')
      const ssrDistDir = path.resolve(resolvedConfig.root, 'dist-ssr')

      console.log('\n🔨 Triggering Internal SSR Build...')
      
      // Programmatically run the SSR build so the user doesn't have to
      await build({
        build: {
          ssr: true,
          outDir: 'dist-ssr',
          rollupOptions: {
            input: Object.fromEntries(routes.map(r => [r.name, r.component])),
            output: {
              format: 'esm' // Native ESM is preferred for modern Node.js import()
            }
          }
        }
      })

      console.log('\n🔨 Pre-rendering routes...\n')

      for (const route of routes) {
        console.log(`  → Rendering: ${route.path}`)

        // 1. Get pre-captured chunk code
        const routeData = routeChunkMap[route.name] ?? {}

        // 2. Render to HTML via the SSR build output
        const renderedHtml = await renderRouteViaSSR(route, ssrDistDir)

        // 3. Assemble inline assets (IIFE format ensures no imports)
        const inlineJs = route.hydrate
          ? (routeData.code ?? '')
          : ''
        const inlineCss = routeData.css ?? ''

        // 4. Build final HTML
        const finalHtml = buildHtmlTemplate({
          route,
          renderedHtml,
          inlineJs,
          inlineCss
        })

        // 5. Write to dist/
        const outputPath = path.join(
          distDir,
          route.name === 'index' ? 'index.html' : `${route.name}.html`
        )
        fs.writeFileSync(outputPath, finalHtml, 'utf-8')
        console.log(`  ✅ Written: ${path.relative(process.cwd(), outputPath)}`)
      }

      // 6. Clean up raw asset files (now inlined in HTML)
      cleanupAssets(distDir)
      
      // 7. Clean up temporary SSR build
      if (fs.existsSync(ssrDistDir)) {
        fs.rmSync(ssrDistDir, { recursive: true, force: true })
        console.log('  🗑️  Cleaned up dist-ssr/ directory')
      }

      console.log('\n✅ Pre-render complete.\n')
    }
  }
}

function cleanupAssets(distDir) {
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) return
  
  // ⚠️ CAUTION: Only delete JS and CSS files that have been inlined.
  // Do NOT delete the entire directory if it contains images/fonts.
  const files = fs.readdirSync(assetsDir)
  files.forEach(file => {
    if (file.endsWith('.js') || file.endsWith('.css')) {
      fs.unlinkSync(path.join(assetsDir, file))
    }
  })
  console.log('  🗑️  Cleaned up inlined JS and CSS from assets/')
}

// Renders a route component to HTML using the SSR build output (dist-ssr/).
// dist-ssr/ is produced internally by the plugin via vite.build().
async function renderRouteViaSSR(route, ssrDistDir) {
  const modulePath = path.resolve(ssrDistDir, `${route.name}.js`) // Vite SSR default is .js

  if (!fs.existsSync(modulePath)) {
    throw new Error(
      `[prerender] SSR build output not found: ${modulePath}\n` +
      `Check the internal build logs for errors during the closeBundle hook.`
    )
  }

  const mod = await import(modulePath)
  const Component = mod.default

  return route.hydrate
    ? renderToString(createElement(Component))
    : renderToStaticMarkup(createElement(Component))
}
```

---

## 11. Dynamic Imports — Handling Strategy

### 11.1 Why Lazy Loading Loses Its Purpose

Standard SPA:
```jsx
// Needed because ALL routes share one bundle
const Blog = lazy(() => import('./Blog'))
// Without this: every user downloads Blog code on every page
```

Our architecture:
```
blog.html already ships ONLY blog's code
about.html already ships ONLY about's code
```

**Lazy loading is solving a problem we've already solved at the HTML level.**

### 11.2 Rule: No `lazy()` in Route Components

```jsx
// ❌ DON'T DO THIS in our architecture
import { lazy } from 'react'
const HeavyChart = lazy(() => import('./HeavyChart'))

// ✅ DO THIS instead
import HeavyChart from './HeavyChart'
// Rollup tree-shakes it per-route. Only blog.html ships it if blog needs it.
```

---

## 12. CDN Externals — Avoiding Fat HTML

### 12.1 The Problem

React + ReactDOM minified: ~45kb gzipped  
Your route code: ~10-20kb gzipped  
Per HTML file total: ~55-65kb

Multiplied by 4 routes = React shipped 4 times. If the site has 20 routes, React is shipped 20 times.

### 12.2 CDN Strategy

```js
// vite.config.js
build: {
  rollupOptions: {
    external: ['react', 'react-dom'],
    output: {
      globals: {
        'react': 'React',
        'react-dom': 'ReactDOM'
      }
    }
  }
}
```

### 12.3 CDN vs Inline Decision Matrix

| Scenario | Strategy |
|---|---|
| Static site, no interactivity | No JS at all. No CDN needed. |
| 1-2 interactive routes | Inline React only in those HTML files |
| 5+ interactive routes | CDN for React. Inline only your code. |
| Offline / intranet app | Must inline React. Accept the size. |
| High traffic, global users | CDN (jsDelivr/unpkg have 99%+ cache hit rate) |

---

## 13. File Size Analysis

### 13.1 Baseline Estimate Per Route

```
Component                          Minified    Gzipped
──────────────────────────────────────────────────────
React + ReactDOM (if inlined)        ~130kb      ~43kb
Your route component + deps           ~15kb       ~5kb
CSS (route-specific)                   ~8kb       ~2kb
──────────────────────────────────────────────────────
TOTAL (with React inlined)           ~153kb      ~50kb
TOTAL (with React on CDN)             ~23kb       ~7kb
```

---

## 14. Testing Strategy

### 14.1 Build Output Verification

```bash
# After build, verify:
# 1. Each route produced a .html file
ls dist/*.html

# 2. No .js or .css files in dist/ (all inlined)
ls dist/assets/  # Should be empty or not exist

# 3. Each HTML is self-contained (no external src= references)
grep -n 'src="' dist/about.html   # Should return nothing (or only CDN links)
grep -n 'href=".*\.css"' dist/about.html  # Should return nothing
```

---

## 15. Known Limitations & Tradeoffs

### 15.1 No Client-Side Navigation

Each link between pages is a **full page load**. No instant SPA navigation.

### 15.2 No Dynamic Routes

```
/blog/[slug]  ← This requires knowing all slugs at build time
```

---

## 16. Implementation Checklist

### POC Phase (do this first)

- [ ] Set up base Vite + React project
- [ ] Create `routes.config.js` with 4 sample routes
- [ ] Create 4 basic route components (no heavy deps)
- [ ] Configure `vite.config.js` with per-route entry points (format: 'iife', inlineDynamicImports: true)
- [ ] Automate SSR build inside plugin via `vite.build()` (no manual second command)
- [ ] Implement `generateBundle` hook to capture chunk code + CSS into `routeChunkMap`
- [ ] Implement `closeBundle` hook to run pre-render pipeline
- [ ] Implement `buildHtmlTemplate()` function (using `<script>` without `type="module"`)
- [ ] Wire up `renderRouteViaSSR()` using the programmatic SSR output
- [ ] Write static HTML files to `dist/`
- [ ] Verify output: `ls dist/` shows 4 HTML files, no assets folder
- [ ] Open each HTML in browser — content should be visible immediately

### Hydration Phase

- [ ] `contact` route already has `hydrate: true` in `routes.config.js` — confirm it is the only interactive route for the POC
- [ ] Implement `renderToString` path in pre-render script
- [ ] Inline route JS (which includes React) only for hydrated routes
- [ ] Ensure hydration logic is correctly guarded in entry points
- [ ] Test: form submits work, no hydration mismatch warnings in console

### Polish Phase

- [ ] Add CDN external option (config flag)
- [ ] Add ESLint rule banning `lazy()`
- [ ] Add build size report (per-route file sizes)
- [ ] Add `--watch` mode for development
- [ ] Handle 404 page as `404.html`
- [ ] Write README for other devs on the team

---

*End of Document*