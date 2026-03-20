// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
// 用户站点根域名：https://bingshuoguo.github.io/（仓库名须为 bingshuoguo.github.io）
export default defineConfig({
  site: 'https://bingshuoguo.github.io',
  vite: {
    plugins: [tailwindcss()]
  }
});