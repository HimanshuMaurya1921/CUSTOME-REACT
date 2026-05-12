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
6. [Phase 3 — The Orchestration Strategy (Double-Pass)](#6-phase-3-the-orchestration-strategy-double-pass)
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

Standard Vite/CRA React builds produce a Single Page Application (SPA). All routes share one HTML entry point. JS handles routing in the browser.

**What we want instead:**
A Multi-Page Application (MPA) where each route is a **self-contained HTML file**.
- **Self-contained** — no external `.js` or `.css` files referenced.
- **Pre-rendered** — actual HTML content, not an empty root div.
- **Scoped** — only ships JS/CSS that its own route needs.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   BUILD PIPELINE                        │
│                                                         │
│  [1] Route Config          routes.config.js             │
│        ↓                                                │
│  [2] Vite Build            Double-Pass Loop             │
│      (Orchestrator)        → Browser IIFE + SSR ESM     │
│        ↓                                                │
│  [3] Pre-Renderer          Node.js + renderToString     │
│        ↓                                                │
│  [4] Asset Inliner         reads chunk JS + CSS         │
│                            injects into HTML            │
│        ↓                                                │
│  [5] Output                dist/about.html (standalone) │
└─────────────────────────────────────────────────────────┘
```

### Core Technologies

| Tool | Role |
|---|---|
| **Vite** | Bundler + dev server |
| **Rollup** | Flattening dependency trees |
| **React DOM Server** | `renderToStaticMarkup` / `renderToString` |
| **Node.js** | Build script runtime |

---

## 3. Folder Structure

```
my-app/
├── src/
│   ├── routes/
│   │   ├── index.jsx
│   │   └── about.jsx
│   └── routes.config.js       ← THE source of truth for routes
├── plugin/
│   └── vite-plugin-prerender.js   ← our custom plugin
└── dist/                      ← output (all self-contained HTML)
```

---

## 4. Phase 1 — Project Setup

### 4.1 Base Vite + React Project

```bash
npm create vite@latest my-prerender-app -- --template react
cd my-prerender-app
npm install
```

> **IMPORTANT:** Ensure `package.json` includes `"type": "module"` to support the plugin's dynamic `import()` calls.

### 4.2 routes.config.js

```js
// src/routes.config.js
const routes = [
  {
    path: '/',
    name: 'index',
    component: './routes/index.jsx',
    hydrate: false,
    title: 'Home',
    meta: {
      description: 'Welcome to our high-performance React site',
      ogImage: 'https://example.com/og-home.jpg'
    }
  },
  {
    path: '/about',
    name: 'about',
    component: './routes/about.jsx',
    hydrate: false,
    title: 'About Us',
    meta: {
      description: 'Learn about our mission',
      ogImage: 'https://example.com/og-about.jpg'
    }
  },
  {
    path: '/contact',
    name: 'contact',
    component: './routes/contact.jsx',
    hydrate: true,         // Interactive route
    title: 'Contact',
    meta: {
      description: 'Get in touch with us',
      ogImage: 'https://example.com/og-contact.jpg'
    }
  },
  {
    path: '/blog',
    name: 'blog',
    component: './routes/blog.jsx',
    hydrate: false,
    title: 'Blog',
    meta: {
      description: 'Read our latest insights',
      ogImage: 'https://example.com/og-blog.jpg'
    }
  }
]
export default routes
```

---

## 5. Phase 2 — Route Discovery

The plugin reads `routes.config.js` at build start to identify the entry points and their corresponding hydration needs.

---

## 6. Phase 3 — The Orchestration Strategy (Double-Pass)

### 6.1 The Rollup Conflict
Rollup forbids `inlineDynamicImports: true` when multiple entry points are provided. We cannot build all routes in a single pass if we want them to be 100% self-contained.

### 6.2 The Solution
The plugin triggers a **programmatic loop** during the `closeBundle` hook, running a dedicated Vite build for each route to ensure perfect flattening and zero external dependencies.

---

## 7. Phase 4 — Pre-rendering

### 7.1 Two Rendering Modes
- **renderToStaticMarkup()**: Pure HTML, zero JS.
- **renderToString()**: HTML with hydration markers for interactivity.

### 7.2 Why Not Puppeteer?
| | `renderToString` | Puppeteer |
|---|---|---|
| Speed | Fast (pure Node) | Slow (Chrome startup) |
| Setup | Low complexity | High (Headless dependencies) |
| Side Effects | None | Runs all `useEffect` |

**Decision: Use React DOM Server for build-time safety.**

---

## 8. Phase 5 — Asset Inlining

In our Double-Pass architecture, each route's browser build produces a single `bundle.js` and `style.css`. These are read from the temporary build directory and injected directly into the HTML template.

---

## 9. Phase 6 — Hydration (Optional)

Routes with `hydrate: true` ship their own flattened IIFE bundle. Interactivity is attached instantly in the browser without any external network requests.

---

## 10. Phase 7 — The Vite Plugin (The Orchestrator)

```js
// plugin/vite-plugin-prerender.js
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { build } from 'vite'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { createElement } from 'react'

export function prerenderPlugin() {
  let resolvedConfig

  return {
    name: 'vite-plugin-prerender',
    enforce: 'post',

    configResolved(config) { resolvedConfig = config },

    async closeBundle() {
      const routes = (await import(pathToFileURL(path.resolve(resolvedConfig.root, 'src/routes.config.js')).href)).default
      const distDir = path.resolve(resolvedConfig.root, 'dist')
      const tempDir = path.resolve(resolvedConfig.root, '.prerender-temp')

      console.log('\n🚀 Starting Master Pre-render Orchestration...\n')

      // 1. Single SSR Build Pass for all routes
      const ssrEntries = {}
      routes.forEach(r => ssrEntries[r.name] = path.resolve(resolvedConfig.root, r.component))
      
      await build({
        build: {
          ssr: true,
          outDir: path.join(tempDir, 'ssr'),
          emptyOutDir: true,
          rollupOptions: {
            input: ssrEntries,
            output: { format: 'esm', entryFileNames: '[name].js' }
          }
        }
      })

      for (const route of routes) {
        console.log(`📦 Processing: ${route.path}`)

        // 2. Per-route Browser IIFE Build
        const browserDir = path.join(tempDir, route.name, 'browser')
        await build({
          build: {
            lib: {
              entry: path.resolve(resolvedConfig.root, route.component),
              formats: ['iife'],
              name: 'app',
              fileName: () => 'bundle.js'
            },
            outDir: browserDir,
            emptyOutDir: true,
            cssCodeSplit: false,
            rollupOptions: { output: { inlineDynamicImports: true } }
          }
        })

        // 3. Asset Assembly
        const inlineJs = fs.readFileSync(path.join(browserDir, 'bundle.js'), 'utf-8')
        const cssPath = path.join(browserDir, 'style.css')
        const inlineCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf-8') : ''

        // 4. Rendering
        const renderedHtml = await renderRouteViaSSR(route, path.join(tempDir, 'ssr'))
        const finalHtml = buildHtmlTemplate({ route, renderedHtml, inlineJs, inlineCss })
        
        const outputName = route.name === 'index' ? 'index.html' : `${route.name}.html`
        fs.writeFileSync(path.join(distDir, outputName), finalHtml)
      }

      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
      console.log('\n✨ Pre-render complete.\n')
    }
  }
}

function buildHtmlTemplate({ route, renderedHtml, inlineJs, inlineCss }) {
  const meta = route.meta || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${route.title}</title>
  <meta name="description" content="${meta.description || ''}" />
  <meta property="og:title" content="${route.title}" />
  <meta property="og:description" content="${meta.description || ''}" />
  <meta property="og:image" content="${meta.ogImage || ''}" />
  <style>${inlineCss}</style>
</head>
<body>
  <div id="root">${renderedHtml}</div>
  ${route.hydrate ? `<script>${inlineJs}</script>` : ''}
</body>
</html>`
}

async function renderRouteViaSSR(route, ssrDir) {
  const modulePath = path.join(ssrDir, `${route.name}.js`)
  const mod = await import(pathToFileURL(modulePath).href)
  const Component = mod.default
  return route.hydrate 
    ? renderToString(createElement(Component)) 
    : renderToStaticMarkup(createElement(Component))
}
```

---

## 11. Dynamic Imports — Handling Strategy
**Rule: No `lazy()` in route components.**  
Our architecture flattens dependency trees per-route. `lazy()` would create secondary chunks that break the "Self-Contained" requirement.

---

## 12. CDN Externals — Avoiding Fat HTML

| Scenario | Strategy |
|---|---|
| Static site | No JS at all. |
| 1-2 interactive routes | Inline React (Simplest). |
| 5+ interactive routes | CDN for React (Best Performance). |

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
- **Verify Asset Inlining:** `ls dist/assets/*.js` should return 0.
- **Verify Pre-rendering:** `grep -c '<div id="root"></div>' dist/index.html` should be 0.
- **Verify SEO:** `grep -c 'property="og:title"' dist/index.html` should be 1.

---

## 15. Known Limitations
- No Client-Side Navigation (Full page loads only).
- No Dynamic Route Parameters (e.g. `[id].jsx`) without custom expansion logic.

---

## 16. Implementation Checklist
- [ ] Project Setup (`"type": "module"`)
- [ ] Route Config with SEO Metadata
- [ ] Double-Pass Orchestrator Plugin
- [ ] Component Hydration Guards
- [ ] Final HTML Output Verification

---

*End of Document*