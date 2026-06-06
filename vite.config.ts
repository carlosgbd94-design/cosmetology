import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'force-mime-type',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url) {
            const urlPath = req.url.split('?')[0];
            if (urlPath.endsWith('.ts') || urlPath.endsWith('.tsx')) {
              res.setHeader('Content-Type', 'application/javascript');
            }
          }
          next();
        });
      }
    }
  ],
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist'
  }
});
