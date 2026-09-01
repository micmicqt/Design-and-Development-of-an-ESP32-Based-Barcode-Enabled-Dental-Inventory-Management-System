import { useRef, useState, type DragEvent } from 'react'
import type { IpcResult, SelectedImageDto } from '../../../shared/ipc-contract'
import { ProductImage } from './ProductImage'

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
])

interface ExistingImage {
  imageUrl: string
  itemName: string
}

interface ReferenceImagePickerProps {
  selectedImage: SelectedImageDto | null
  existingImage?: ExistingImage | null
  compact?: boolean
  disabled?: boolean
  onImageSelected: (image: SelectedImageDto) => void
  onRemove: () => void
  onError: (message: string | null) => void
  onProcessingChange?: (processing: boolean) => void
}

function isSupportedFileDrag(event: DragEvent<HTMLElement>): boolean {
  const files = Array.from(event.dataTransfer.files)
  if (files.length > 0) {
    const file = files[0]
    return (
      files.length === 1 &&
      file !== undefined &&
      (SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase()) ||
        /\.(?:png|jpe?g|webp)$/i.test(file.name))
    )
  }

  const fileItems = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file')
  if (fileItems.length !== 1) return false
  return fileItems.every((item) => {
    const type = item.type.toLowerCase()
    return type.length === 0 || SUPPORTED_IMAGE_MIME_TYPES.has(type)
  })
}

export function ReferenceImagePicker({
  selectedImage,
  existingImage = null,
  compact = false,
  disabled = false,
  onImageSelected,
  onRemove,
  onError,
  onProcessingChange
}: ReferenceImagePickerProps) {
  const [processing, setProcessing] = useState(false)
  const [dragState, setDragState] = useState<'idle' | 'supported' | 'unsupported'>('idle')
  const dragDepth = useRef(0)
  const hasExistingImage = existingImage !== null
  const hasImage = selectedImage !== null || hasExistingImage

  function setBusy(value: boolean): void {
    setProcessing(value)
    onProcessingChange?.(value)
  }

  async function consumeSelection(
    request: () => Promise<IpcResult<SelectedImageDto | null>>
  ): Promise<void> {
    if (disabled || processing) return
    setBusy(true)
    onError(null)

    try {
      const result = await request()
      if (!result.ok) {
        onError(result.error.message)
      } else if (result.value !== null) {
        onImageSelected(result.value)
      }
    } catch {
      onError('The image could not be selected. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function browse(): void {
    void consumeSelection(() => window.desktopApi.inventory.selectImage())
  }

  function handleDragEnter(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current += 1
    const supported = isSupportedFileDrag(event)
    setDragState(supported ? 'supported' : 'unsupported')
    if (!supported) {
      const fileCount =
        event.dataTransfer.files.length ||
        Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file').length
      onError(
        fileCount > 1
          ? 'Drop one image at a time.'
          : 'Select a PNG, JPG, JPEG, or WEBP image.'
      )
    }
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const supported = isSupportedFileDrag(event)
    event.dataTransfer.dropEffect = supported ? 'copy' : 'none'
    setDragState(supported ? 'supported' : 'unsupported')
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragState('idle')
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDragState('idle')

    const files = Array.from(event.dataTransfer.files)
    const file = files[0]
    if (files.length !== 1 || file === undefined) {
      onError(files.length > 1 ? 'Drop one image at a time.' : 'No image was found in the drop.')
      return
    }

    void consumeSelection(() => window.desktopApi.inventory.selectDroppedImage(file))
  }

  const pickerClassName = [
    'image-picker',
    compact ? 'image-picker--compact' : '',
    dragState === 'supported' ? 'is-dragging' : '',
    dragState === 'unsupported' ? 'is-dragging-unsupported' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={pickerClassName} aria-labelledby="reference-image-heading">
      <div className="image-picker__heading">
        <span className="form-label" id="reference-image-heading">
          Reference Image
        </span>
        <small>Optional · PNG, JPG, JPEG, or WEBP · 10 MiB maximum</small>
      </div>

      <button
        className="image-picker__dropzone"
        type="button"
        aria-label={hasImage ? 'Browse to replace reference image' : 'Browse for a reference image'}
        onClick={browse}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={disabled || processing}
      >
        {selectedImage !== null ? (
          <span className="image-picker__preview">
            <img src={selectedImage.previewDataUrl} alt="Reference image preview" />
            <span title={selectedImage.originalName}>{selectedImage.originalName}</span>
          </span>
        ) : existingImage !== null ? (
          <ProductImage
            imageUrl={existingImage.imageUrl}
            itemName={existingImage.itemName}
            className="image-picker__existing"
          />
        ) : (
          <span className="image-picker__placeholder">
            <span className="image-picker__plus" aria-hidden="true">
              +
            </span>
            <strong>
              {dragState === 'supported' ? 'Release to add image' : 'Drop an image here'}
            </strong>
            <small>{dragState === 'unsupported' ? 'Unsupported image format' : 'or click to browse'}</small>
          </span>
        )}
      </button>

      <div className="image-picker__buttons">
        <button
          className="secondary-button"
          type="button"
          onClick={browse}
          disabled={disabled || processing}
        >
          {processing ? 'Reading image…' : hasImage ? 'Replace image' : 'Browse images'}
        </button>
        {hasImage && (
          <button
            className="secondary-button secondary-button--danger"
            type="button"
            onClick={onRemove}
            disabled={disabled || processing}
          >
            Remove image
          </button>
        )}
      </div>
    </section>
  )
}
