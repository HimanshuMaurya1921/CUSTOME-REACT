// plugin/vite-plugin-prerender.js
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { build } from 'vite'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { performance } from 'perf_hooks'

export function prerenderPlugin() {
  let resolvedConfig

  return {
    name: 'vite-plugin-prerender',
    enforce: 'post',

    configResolved(config) {
      resolvedConfig = config
    },

    async closeBundle() {
      const startTime = performance.now()
      const tempDir = path.resolve(resolvedConfig.root, '.prerender-temp')
      const distDir = path.resolve(resolvedConfig.root, 'dist')
      
      try {
        // 1. Load routes config
        const routesConfigPath = path.resolve(resolvedConfig.root, 'src/routes.config.js')
        if (!fs.existsSync(routesConfigPath)) {
          throw new Error(`Route configuration not found at ${routesConfigPath}`)
        }
        
        const { default: routes } = await import(pathToFileURL(routesConfigPath).href)
        
        console.log('\n' + '='.repeat(60))
        console.log('🚀 REACT PRE-RENDER ORCHESTRATOR')
        console.log('='.repeat(60))
        console.log(`📂 Found ${routes.length} routes to process.`)

        // 2. Single SSR Build Pass
        const ssrStartTime = performance.now()
        console.log('\n📦 STAGE 1: Universal SSR Build')
        const ssrEntries = {}
        routes.forEach(r => {
          const componentPath = path.resolve(resolvedConfig.root, 'src', r.component.replace('./', ''))
          if (!fs.existsSync(componentPath)) {
             throw new Error(`Component not found for route ${r.path}: ${componentPath}`)
          }
          ssrEntries[r.name] = componentPath
        })
        
        await build({
          build: {
            ssr: true,
            outDir: path.join(tempDir, 'ssr'),
            emptyOutDir: true,
            rollupOptions: {
              input: ssrEntries,
              output: {
                format: 'esm',
                entryFileNames: '[name].js'
              }
            }
          },
          configFile: false,
          logLevel: 'warn'
        })
        console.log(`✅ SSR Build complete in ${((performance.now() - ssrStartTime) / 1000).toFixed(2)}s`)

        // 3. Per-Route Processing
        console.log('\n📦 STAGE 2: Per-Route Isolation & Assembly')
        
        for (const route of routes) {
          const routeStartTime = performance.now()
          console.log(`\n  --- Processing: [${route.path}] ---`)

          // 3. Per-Route Browser Build (IIFE Flattening + CSS Extraction)
          // We run this for ALL routes to ensure CSS is captured, 
          // but we only inline JS if the route is hydrated.
          const browserDir = path.join(tempDir, route.name, 'browser')
          const componentPath = path.resolve(resolvedConfig.root, 'src', route.component.replace('./', ''))
          const buildEntryPath = route.hydrate 
              ? path.join(tempDir, `${route.name}-hydrate.jsx`)
              : componentPath

          if (route.hydrate) {
              console.log(`  [Hydration] Generating browser bundle...`)
              const hydrationEntryContent = `
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import Component from '${componentPath.replace(/\\/g, '/')}';
const root = document.getElementById('root');
if (root) hydrateRoot(root, React.createElement(Component));
              `
              fs.writeFileSync(buildEntryPath, hydrationEntryContent)
          } else {
              console.log(`  [Static] Extracting styles...`)
          }

          await build({
            build: {
              lib: {
                entry: buildEntryPath,
                formats: ['iife'],
                name: 'app',
                fileName: () => 'bundle.js'
              },
              outDir: browserDir,
              emptyOutDir: true,
              cssCodeSplit: false,
              rollupOptions: {
                output: { inlineDynamicImports: true }
              }
            },
            configFile: false,
            logLevel: 'warn'
          })

          // 4. Asset Assembly
          let inlineJs = ''
          let inlineCss = ''
          
          if (route.hydrate) {
              const bundlePath = path.join(browserDir, 'bundle.js')
              if (fs.existsSync(bundlePath)) {
                  inlineJs = fs.readFileSync(bundlePath, 'utf-8')
                  console.log(`  [Hydration] Inlined JS: ${(inlineJs.length / 1024).toFixed(2)} KB`)
              }
          }

          // CSS Extraction - Robust Discovery
          const searchDirs = [browserDir, path.join(tempDir, 'ssr')]
          
          for (const dir of searchDirs) {
            if (fs.existsSync(dir)) {
              const files = fs.readdirSync(dir)
              const cssFile = files.find(f => f.endsWith('.css'))
              if (cssFile) {
                const cssPath = path.join(dir, cssFile)
                inlineCss = fs.readFileSync(cssPath, 'utf-8')
                console.log(`  [Style] Inlined CSS from ${cssFile}: ${(inlineCss.length / 1024).toFixed(2)} KB`)
                break
              }
            }
          }

          // SSR Rendering
          console.log(`  [Render] Executing SSR...`)
          const renderedHtml = await renderRouteViaSSR(route, path.join(tempDir, 'ssr'))
          const finalHtml = buildHtmlTemplate({ route, renderedHtml, inlineJs, inlineCss })
          
          const outputName = route.name === 'index' ? 'index.html' : `${route.name}.html`
          fs.writeFileSync(path.join(distDir, outputName), finalHtml)
          
          console.log(`  ✅ Written: ${outputName} (${((performance.now() - routeStartTime) / 1000).toFixed(2)}s)`)
        }

      } catch (error) {
        console.error('\n❌ PRE-RENDER FAILED')
        console.error(`   Error: ${error.message}`)
        console.error(error.stack)
        throw error
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true })
        }
        const totalTime = ((performance.now() - startTime) / 1000).toFixed(2)
        console.log('\n' + '='.repeat(60))
        console.log(`✨ ORCHESTRATION COMPLETE in ${totalTime}s`)
        console.log('='.repeat(60) + '\n')
      }
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
