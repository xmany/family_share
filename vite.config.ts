import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const API_PORT = Number(process.env.PORT ?? 8787)

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Allow Tailscale Funnel / tunnel hostnames when testing on real phones
    allowedHosts: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
      '/healthz': { target: `http://127.0.0.1:${API_PORT}` },
      '/wechat': { target: `http://127.0.0.1:${API_PORT}` },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: '.',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: true, type: 'module' },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'] },
      manifest: {
        name: '家庭同步',
        short_name: '家庭同步',
        description: '说一句话，家里的事就安排好了',
        lang: 'zh-CN',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f1ea',
        theme_color: '#f5f1ea',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
