import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  build: {
    rollupOptions: {
      // Two entry points: the bird (`/`) and the tank (`/tank/`). Registering both means Vite emits
      // `dist/tank/index.html` with correctly hashed asset URLs, so `/tank/` is a real page rather
      // than a client-side branch on the path.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        tank: fileURLToPath(new URL('./tank/index.html', import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      '/local-certificate-hash': {
        target: 'http://127.0.0.1:8699',
        rewrite: () => '/certificate-hash',
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tensorflow-models/pose-detection': fileURLToPath(new URL('./node_modules/@tensorflow-models/pose-detection/dist/index.js', import.meta.url)),
    },
  },
})
