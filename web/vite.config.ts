import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // The action catalog (human action names) lives under /admin/catalog,
      // not /api — proxy it to the same backend in dev.
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
