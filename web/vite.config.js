import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API and download links are served by the backend on :4600.
const backend = process.env.ROUTERHUB_BACKEND || 'http://localhost:4600';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/dl': backend,
    },
  },
});
