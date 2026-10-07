import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getStableUserDataPath,
  prepareStableUserDataPath,
  resolveApplicationPaths
} from '../../src/main/application/application-paths'

describe('branded Windows package keeps existing clinic data location', () => {
  it('uses the legacy userData directory despite the visible product rename', () => {
    const appData = resolve('test-profile', 'AppData', 'Roaming')
    const userData = getStableUserDataPath(appData)
    const paths = resolveApplicationPaths(userData)

    expect(userData).toBe(join(appData, 'Dental Inventory System'))
    expect(paths.databasePath).toBe(join(userData, 'data', 'inventory.db'))
    expect(paths.productImagesDirectory).toBe(join(userData, 'data', 'product-images'))
  })

  it('creates the legacy userData directory before Electron selects it on first launch', () => {
    const appData = mkdtempSync(join(tmpdir(), 'dental-package-test-'))
    try {
      const userData = prepareStableUserDataPath(appData)
      expect(userData).toBe(join(appData, 'Dental Inventory System'))
      expect(existsSync(userData)).toBe(true)
    } finally {
      rmSync(appData, { recursive: true, force: true })
    }
  })

  it('preserves the existing development-only database override', () => {
    const override = join('test-profile', 'isolated-inventory.db')
    expect(resolveApplicationPaths(getStableUserDataPath('test-profile'), override)
      .databasePath).toBe(join(process.cwd(), override))
  })
})
