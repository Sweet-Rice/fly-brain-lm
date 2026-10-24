import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const allowedHosts = (process.env.FLYBRAIN_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { main: 'index.html', brainPreview: 'brain-preview.html' },
    },
  },
  server: { port: 5173, strictPort: true, allowedHosts },
  preview: { port: 4173, strictPort: true, allowedHosts },
});
