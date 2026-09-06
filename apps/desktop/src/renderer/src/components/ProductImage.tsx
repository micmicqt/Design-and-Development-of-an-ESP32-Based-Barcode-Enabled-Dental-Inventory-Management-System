import { useState } from 'react'
import clinicLogo from '../assets/branding/any-time-dental-logo.png'

export function ProductImage({
  imageUrl,
  itemName,
  className = ''
}: {
  imageUrl: string | null
  itemName: string
  className?: string
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const unavailable = imageUrl !== null && failedImageUrl === imageUrl

  if (imageUrl === null || unavailable) {
    return (
      <div
        className={`product-image-placeholder ${className}`.trim()}
        role="img"
        aria-label={`No image for ${itemName}`}
      >
        <img src={clinicLogo} alt="" aria-hidden="true" />
      </div>
    )
  }

  return (
    <img
      className={`product-image ${className}`.trim()}
      src={imageUrl}
      alt={`${itemName} reference`}
      onError={() => setFailedImageUrl(imageUrl)}
      onLoad={() => setFailedImageUrl(null)}
    />
  )
}
