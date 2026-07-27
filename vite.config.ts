import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/cosmetology/',
  plugins: [react()],
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'pdf-vendor': ['@react-pdf/renderer'],
          'excel-vendor': ['xlsx', 'fuse.js'],
          'icons-vendor': ['lucide-react']
        }
      }
    }
  }
});
