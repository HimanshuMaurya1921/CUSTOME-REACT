# React Pre-Render POC — Technical Design Document

**Author:** Senior System Design & React Engineer  
**Status:** R&D / Pre-Implementation  
**Goal:** Build a custom Vite plugin that pre-renders React routes into fully self-contained HTML files (inlined JS + CSS, no external assets)

---

## 1. Problem Statement

Standard Vite builds produce a single SPA shell. We want a Multi-Page Application (MPA) where each route is a **self-contained HTML file** with its own inlined JS/CSS and no external dependencies.

---

## 2. Architecture Overview (The Double-Pass Strategy)

To achieve 100% self-contained IIFEs for multiple routes, the plugin orchestrates a two-step build process:

1.  **Main Build:** Standard Vite build triggers the plugin.
2.  **Orchestration Loop:** For each route in `routes.config.js`:
    - **Pass A (Browser):** A programmatic `vite.build()` generates a flattened IIFE bundle.
    - **Pass B (SSR):** A programmatic `vite.build()` generates an ESM module for Node.js rendering.
    - **Final Step:** Inlines assets into the SSR-rendered HTML and writes to `dist/`.

---

## 3. Folder Structure

```
my-app/
├── src/
│   ├── routes/
│   │   ├── index.jsx          ← Home
│   │   ├── about.jsx          ← About
│   │   ├── contact.jsx        ← Contact (Hydrated)
│   │   └── 404.jsx            ← 404 Page
│   └── routes.config.js       ← Source of Truth
├── plugin/
│   └── vite-plugin-prerender.js   ← Orchestrator
└── vite.config.js
```

---

## 4. Phase 1 — Project Setup

### 4.1 Base Setup
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
    meta: { description: 'Welcome to our high-performance React site' }
  },
  {
    path: '/contact',
    name: 'contact',
    component: './routes/contact.jsx',
    hydrate: true,         // Interactive route
    title: 'Contact',
    meta: { description: 'Get in touch with us' }
  },
  {
    path: '/404',
    name: '404',            // Special name: will generate 404.html
    component: './routes/404.jsx',
    hydrate: false,
    title: '404 - Not Found',
    meta: { description: 'Page not found' }
  }
]
export default routes
```

---

## 5. Phase 2 — Route Discovery

The plugin dynamically imports the route configuration during the `closeBundle` hook to derive the build targets.

```js
// Discovery logic used inside the plugin
async function getRoutes(root) {
  const configPath = path.resolve(root, 'src/routes.config.js')
  const { default: routes } = await import(pathToFileURL(configPath).href)
  return routes
}
```

---

## 10. Phase 7 — The Vite Plugin (The Orchestrator)

This is the optimized "Hybrid Orchestration" implementation.

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

      // 1. Single SSR Build Pass (Deterministic ESM)
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

        // 2. Per-Route Browser Build (IIFE Flattening)
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
        console.log(`  ✅ Written: ${outputName}`)
      }

      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
      console.log('\n✨ Pre-render complete.\n')
    }
  }
}

function buildHtmlTemplate({ route, renderedHtml, inlineJs, inlineCss }) {
  const meta = route.meta || {}
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${route.title}</title>
  <meta name="description" content="${meta.description || ''}" />
  <meta property="og:title" content="${route.title}" />
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

## 13. File Size Analysis

```
Component                          Minified    Gzipped
──────────────────────────────────────────────────────
React + ReactDOM (if inlined)        ~130kb      ~43kb
Your route component + deps           ~15kb       ~5kb
CSS (route-specific)                   ~8kb       ~2kb
──────────────────────────────────────────────────────
TOTAL (with React inlined)           ~153kb      ~50kb
```

---

## 14. Testing Strategy

```bash
# 1. Verify Output
ls dist/*.html

# 2. Verify Asset Inlining (Should be 0)
ls dist/assets/*.js | wc -l

# 3. Verify Pre-rendering
grep -c '<div id="root"></div>' dist/index.html # Should be 0

# 4. Verify SEO
grep -c 'property="og:title"' dist/index.html # Should be 1
```

---

## 16. Implementation Checklist
- [ ] Set `"type": "module"` in `package.json`.
- [ ] Add `{ name: '404', path: '/404' }` to `routes.config.js`.
- [ ] Implement `prerenderPlugin` with optimized SSR pass.
- [ ] Verify 100% self-contained HTML in `dist/`.

---

*End of Document*