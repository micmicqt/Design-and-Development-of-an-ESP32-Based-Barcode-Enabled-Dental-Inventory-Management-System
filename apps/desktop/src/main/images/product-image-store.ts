import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SelectedImageDto } from '../../shared/ipc-contract'

export const DENTAL_IMAGE_SCHEME = 'dental-image'
export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024
export const MANAGED_IMAGE_PATH_PATTERN =
  /^product-images\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp))$/i

const SELECTION_TTL_MS = 15 * 60 * 1000
const MAX_ACTIVE_SELECTIONS = 8

export type ProductImageErrorCode =
  | 'IMAGE_INVALID_TYPE'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_UNAVAILABLE'

export class ProductImageError extends Error {
  readonly code: ProductImageErrorCode

  constructor(code: ProductImageErrorCode, message: string) {
    super(message)
    this.name = 'ProductImageError'
    this.code = code
  }
}

interface ImageFormat {
  extension: 'png' | 'jpg' | 'webp'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}

interface PendingSelection extends ImageFormat {
  buffer: Buffer
  createdAt: number
}

export interface StoredProductImage {
  relativePath: string
}

export interface ManagedImageResponse {
  body: Buffer
  mimeType: ImageFormat['mimeType']
}

function formatFromExtension(filePath: string): ImageFormat | null {
  switch (extname(filePath).toLowerCase()) {
    case '.png':
      return { extension: 'png', mimeType: 'image/png' }
    case '.jpg':
    case '.jpeg':
      return { extension: 'jpg', mimeType: 'image/jpeg' }
    case '.webp':
      return { extension: 'webp', mimeType: 'image/webp' }
    default:
      return null
  }
}

function hasExpectedSignature(buffer: Buffer, format: ImageFormat): boolean {
  if (format.extension === 'png') {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
  }

  if (format.extension === 'jpg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }

  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

function formatFromManagedFilename(filename: string): ImageFormat | null {
  return formatFromExtension(filename)
}

function unavailable(message = 'The selected image is no longer available.'): ProductImageError {
  return new ProductImageError('IMAGE_UNAVAILABLE', message)
}

export class ProductImageStore {
  private readonly selections = new Map<string, PendingSelection>()

  constructor(private readonly imageDirectory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.imageDirectory, { recursive: true })
  }

  async createSelectionFromPath(sourcePath: string): Promise<SelectedImageDto> {
    const format = formatFromExtension(sourcePath)
    if (format === null) {
      throw new ProductImageError(
        'IMAGE_INVALID_TYPE',
        'Select a PNG, JPG, JPEG, or WEBP image.'
      )
    }

    let sourceStats
    try {
      sourceStats = await stat(sourcePath)
    } catch {
      throw unavailable()
    }

    if (!sourceStats.isFile()) throw unavailable()
    if (sourceStats.size > MAX_PRODUCT_IMAGE_BYTES) {
      throw new ProductImageError('IMAGE_TOO_LARGE', 'The selected image must be 10 MiB or smaller.')
    }

    let buffer: Buffer
    try {
      buffer = await readFile(sourcePath)
    } catch {
      throw unavailable()
    }

    if (!hasExpectedSignature(buffer, format)) {
      throw new ProductImageError(
        'IMAGE_INVALID_TYPE',
        'The selected file does not contain a valid supported image.'
      )
    }

    this.pruneSelections()
    while (this.selections.size >= MAX_ACTIVE_SELECTIONS) {
      const oldestToken = this.selections.keys().next().value as string | undefined
      if (oldestToken === undefined) break
      this.selections.delete(oldestToken)
    }

    const selectionToken = randomUUID()
    this.selections.set(selectionToken, { ...format, buffer, createdAt: Date.now() })

    return {
      selectionToken,
      previewDataUrl: `data:${format.mimeType};base64,${buffer.toString('base64')}`,
      originalName: basename(sourcePath)
    }
  }

  async persistSelection(selectionToken: string): Promise<StoredProductImage> {
    this.pruneSelections()
    const selection = this.selections.get(selectionToken)
    if (selection === undefined) throw unavailable()

    await this.initialize()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const filename = `${randomUUID()}.${selection.extension}`
      const absolutePath = join(this.imageDirectory, filename)

      try {
        await writeFile(absolutePath, selection.buffer, { flag: 'wx', mode: 0o600 })
        return { relativePath: `product-images/${filename}` }
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          continue
        }
        throw unavailable('The image could not be copied into application storage.')
      }
    }

    throw unavailable('A collision-safe image filename could not be generated.')
  }

  discardSelection(selectionToken: string): void {
    this.selections.delete(selectionToken)
  }

  clearSelections(): void {
    this.selections.clear()
  }

  toRendererUrl(relativePath: string | null | undefined): string | null {
    if (!relativePath) return null
    const match = MANAGED_IMAGE_PATH_PATTERN.exec(relativePath)
    if (match === null || match[1] === undefined) return null
    return `${DENTAL_IMAGE_SCHEME}://product/${match[1]}`
  }

  async removeManagedImage(relativePath: string | null | undefined): Promise<void> {
    const match = relativePath ? MANAGED_IMAGE_PATH_PATTERN.exec(relativePath) : null
    const filename = match?.[1]
    if (filename === undefined) return

    try {
      await unlink(join(this.imageDirectory, filename))
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
  }

  async readManagedImageRequest(requestUrl: string): Promise<ManagedImageResponse | null> {
    let url: URL
    try {
      url = new URL(requestUrl)
    } catch {
      return null
    }

    if (url.protocol !== `${DENTAL_IMAGE_SCHEME}:` || url.hostname !== 'product') return null
    if (url.search !== '' || url.hash !== '') return null

    let filename: string
    try {
      filename = decodeURIComponent(url.pathname.slice(1))
    } catch {
      return null
    }

    if (filename.includes('/') || filename.includes('\\')) return null
    const relativePath = `product-images/${filename}`
    if (!MANAGED_IMAGE_PATH_PATTERN.test(relativePath)) return null

    const format = formatFromManagedFilename(filename)
    if (format === null) return null

    const absolutePath = join(this.imageDirectory, filename)
    try {
      await access(absolutePath, fsConstants.R_OK)
      return { body: await readFile(absolutePath), mimeType: format.mimeType }
    } catch {
      return null
    }
  }

  private pruneSelections(): void {
    const oldestAllowed = Date.now() - SELECTION_TTL_MS
    for (const [token, selection] of this.selections) {
      if (selection.createdAt < oldestAllowed) this.selections.delete(token)
    }
  }
}
