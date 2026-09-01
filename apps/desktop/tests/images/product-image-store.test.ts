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
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00])
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
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

  it.each([
    ['PNG', 'reference.png', PNG_BYTES, 'image/png', /\.png$/],
    ['JPG', 'reference.jpg', JPEG_BYTES, 'image/jpeg', /\.jpg$/],
    ['JPEG', 'reference.jpeg', JPEG_BYTES, 'image/jpeg', /\.jpg$/],
    ['WEBP', 'reference.webp', WEBP_BYTES, 'image/webp', /\.webp$/]
  ])(
    'accepts a valid %s reference image through the secure selection pipeline',
    async (_label, filename, bytes, mimeType, managedExtension) => {
      const candidatePath = join(temporaryDirectory, filename as string)
      await writeFile(candidatePath, bytes as Buffer)

      const selection = await imageStore.createSelectionFromPath(candidatePath)
      const stored = await imageStore.persistSelection(selection.selectionToken)

      expect(selection.originalName).toBe(filename)
      expect(selection.previewDataUrl).toMatch(new RegExp(`^data:${mimeType};base64,`))
      expect(stored.relativePath).toMatch(managedExtension as RegExp)
      expect(await readFile(join(temporaryDirectory, 'data', stored.relativePath))).toEqual(bytes)
    }
  )

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

  it('removes only a managed image path and treats repeat cleanup as safe', async () => {
    const selection = await imageStore.createSelectionFromPath(sourcePath)
    const stored = await imageStore.persistSelection(selection.selectionToken)
    const storedPath = join(temporaryDirectory, 'data', stored.relativePath)

    await imageStore.removeManagedImage(stored.relativePath)
    await expect(readFile(storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(imageStore.removeManagedImage(stored.relativePath)).resolves.toBeUndefined()
    await expect(imageStore.removeManagedImage('../outside.png')).resolves.toBeUndefined()
  })
})
