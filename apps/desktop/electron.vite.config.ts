import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'

export default defineConfig(({ mode }) => {
  const localEnvironment = loadEnv(mode, process.cwd(), ['DENTAL_'])
  const configuredBaseUrl = localEnvironment.DENTAL_ESP32_BASE_URL?.trim()
  if (
    process.env.DENTAL_ESP32_BASE_URL === undefined &&
    configuredBaseUrl !== undefined &&
    configuredBaseUrl.length > 0
  ) {
    process.env.DENTAL_ESP32_BASE_URL = configuredBaseUrl
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()]
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            chunkFileNames: '[name]-[hash].cjs'
          }
        }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [react()]
    }
  }
})
