// @vitest-environment node

import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MANAGED_IMAGE_PATH_PATTERN,
  MAX_PRODUCT_IMAGE_BYTES,
  ProductImageStore,
  type ProductImageError
} from '../../src/main/images'

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
])

describe('managed product images', () => {
  let temporaryDirectory: string
  let sourcePath: string
  let imageDirectory: string
  let imageStore: ProductImageStore

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'dental-product-image-'))
    sourcePath = join(temporaryDirectory, 'reference.png')
    imageDirectory = join(temporaryDirectory, 'data', 'product-images')
    await writeFile(sourcePath, PNG_BYTES)
    imageStore = new ProductImageStore(imageDirectory)
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('returns an opaque preview token and persists a collision-safe relative path', async () => {
    const selection = await imageStore.createSelectionFromPath(sourcePath)
    const first = await imageStore.persistSelection(selection.selectionToken)
    const second = await imageStore.persistSelection(selection.selectionToken)

    expect(selection.originalName).toBe('reference.png')
    expect(selection.previewDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(selection).not.toHaveProperty('sourcePath')
    expect(first.relativePath).toMatch(MANAGED_IMAGE_PATH_PATTERN)
    expect(second.relativePath).toMatch(MANAGED_IMAGE_PATH_PATTERN)
    expect(second.relativePath).not.toBe(first.relativePath)
    expect(await readFile(join(temporaryDirectory, 'data', first.relativePath))).toEqual(PNG_BYTES)
  })

  it('rejects a supported extension whose bytes are not that image type', async () => {
    await writeFile(sourcePath, Buffer.from('not an image'))
    await expect(imageStore.createSelectionFromPath(sourcePath)).rejects.toMatchObject({
      code: 'IMAGE_INVALID_TYPE'
    } satisfies Partial<ProductImageError>)
  })

  it('rejects images larger than the documented 10 MiB limit before reading them', async () => {
    await truncate(sourcePath, MAX_PRODUCT_IMAGE_BYTES + 1)
    await expect(imageStore.createSelectionFromPath(sourcePath)).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    } satisfies Partial<ProductImageError>)
  })

  it('serves only managed product filenames and returns null for traversal or missing files', async () => {
    const selection = await imageStore.createSelectionFromPath(sourcePath)
    const stored = await imageStore.persistSelection(selection.selectionToken)
    const imageUrl = imageStore.toRendererUrl(stored.relativePath)

    expect(imageUrl).toMatch(/^dental-image:\/\/product\//)
    await expect(imageStore.readManagedImageRequest(imageUrl as string)).resolves.toMatchObject({
      body: PNG_BYTES,
      mimeType: 'image/png'
    })
    await expect(
      imageStore.readManagedImageRequest('dental-image://product/%2e%2e%2fsecret.jpg')
    ).resolves.toBeNull()
    await expect(
      imageStore.readManagedImageRequest(
        'dental-image://product/00000000-0000-4000-8000-000000000000.jpg'
      )
    ).resolves.toBeNull()
    expect(imageStore.toRendererUrl('../secret.jpg')).toBeNull()
  })
})
