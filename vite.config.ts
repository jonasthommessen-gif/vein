import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves under /vein/; Vercel root deploys can override with VITE_BASE=/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/vein/',
})
