export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devServer: { host: '0.0.0.0' },
  vite: {
    server: { allowedHosts: ['web.nuxt-demo.lndo.site'] },
  },
})
