import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getProductionDatabasePath } from '../database'

export const PRODUCT_IMAGES_DIRECTORY_NAME = 'product-images'
export const LEGACY_USER_DATA_DIRECTORY_NAME = 'Dental Inventory System'

export function getStableUserDataPath(appDataPath: string): string {
  return join(appDataPath, LEGACY_USER_DATA_DIRECTORY_NAME)
}

export function prepareStableUserDataPath(appDataPath: string): string {
  const userDataPath = getStableUserDataPath(appDataPath)
  mkdirSync(userDataPath, { recursive: true })
  return userDataPath
}

export interface ApplicationPaths {
  databasePath: string
  dataDirectory: string
  productImagesDirectory: string
}

export function resolveApplicationPaths(
  userDataPath: string,
  developmentDatabasePath?: string
): ApplicationPaths {
  const databaseOverride = developmentDatabasePath?.trim()
  const databasePath = databaseOverride
    ? resolve(databaseOverride)
    : getProductionDatabasePath(userDataPath)
  const dataDirectory = dirname(databasePath)

  return {
    databasePath,
    dataDirectory,
    productImagesDirectory: join(dataDirectory, PRODUCT_IMAGES_DIRECTORY_NAME)
  }
}
