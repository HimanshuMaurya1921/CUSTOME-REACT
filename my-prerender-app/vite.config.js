import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { prerenderPlugin } from './plugin/vite-plugin-prerender.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    prerenderPlugin()
  ],
})
