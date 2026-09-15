// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  vite: {
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:50000',
        '/user-data': 'http://127.0.0.1:50000',
      },
    },
  },
  integrations: [react()]
});
