// scripts/verify-build.js
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

async function runTests() {
  const root = process.cwd()
  const distDir = path.resolve(root, 'dist')
  const routesConfigPath = path.resolve(root, 'src/routes.config.js')
  const logFile = path.resolve(root, 'build-test.log')
  
  let logContent = `BUILD VERIFICATION REPORT - ${new Date().toISOString()}\n`
  logContent += `============================================================\n\n`

  function log(msg) {
    console.log(msg)
    logContent += msg + '\n'
  }

  try {
    const { default: routes } = await import(pathToFileURL(routesConfigPath).href)
    let totalTests = 0
    let passedTests = 0

    for (const route of routes) {
      const fileName = route.name === 'index' ? 'index.html' : `${route.name}.html`
      const filePath = path.join(distDir, fileName)
      
      log(`🔎 Testing Route: [${route.path}] -> ${fileName}`)
      
      if (!fs.existsSync(filePath)) {
        log(`  ❌ FAILED: File not found: ${fileName}`)
        continue
      }

      const html = fs.readFileSync(filePath, 'utf-8')
      
      // 1. Content check
      const hasContent = html.includes('<div id="root">') && !html.includes('<div id="root"></div>')
      log(`  - Pre-rendered content: ${hasContent ? '✅' : '❌'}`)
      if (hasContent) passedTests++
      totalTests++

      // 2. Hydration check
      if (route.hydrate) {
        const hasScript = html.includes('<script>') && html.includes('hydrateRoot')
        log(`  - Hydration script inlined: ${hasScript ? '✅' : '❌'}`)
        if (hasScript) passedTests++
      } else {
        const hasNoScript = !html.includes('<script>')
        log(`  - Zero-JS static page: ${hasNoScript ? '✅' : '❌'}`)
        if (hasNoScript) passedTests++
      }
      totalTests++

      // 3. Asset inlining check (Safety)
      const hasExternalJs = /<script.*src=.*assets\//.test(html)
      const hasExternalCss = /<link.*href=.*assets\//.test(html)
      log(`  - No external assets: ${(!hasExternalJs && !hasExternalCss) ? '✅' : '❌'}`)
      if (!hasExternalJs && !hasExternalCss) passedTests++
      totalTests++

      // 4. SEO Tags
      const hasTitle = html.includes(`<title>${route.title}</title>`)
      const hasDesc = html.includes(`content="${route.meta.description}"`)
      const hasOg = html.includes(`property="og:title" content="${route.title}"`)
      log(`  - SEO Metadata: ${(hasTitle && hasDesc && hasOg) ? '✅' : '❌'}`)
      if (hasTitle && hasDesc && hasOg) passedTests++
      totalTests++
      
      // 5. CSS inlining check
      const styleMatch = html.match(/<style>(.*?)<\/style>/s)
      const hasCss = styleMatch && styleMatch[1].trim().length > 0
      log(`  - CSS inlined: ${hasCss ? '✅' : '❌'}`)
      if (hasCss) passedTests++
      totalTests++
      
      log('')
    }

    log(`============================================================`)
    log(`FINAL RESULT: ${passedTests}/${totalTests} tests passed.`)
    log(`============================================================\n`)

    fs.writeFileSync(logFile, logContent)
    if (passedTests < totalTests) {
      process.exit(1)
    }

  } catch (error) {
    log(`\n❌ FATAL ERROR DURING TESTING:`)
    log(error.stack)
    fs.writeFileSync(logFile, logContent)
    process.exit(1)
  }
}

runTests()
