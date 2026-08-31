import { useEffect, useState } from 'react'

export function ProductImage({
  imageUrl,
  itemName,
  className = ''
}: {
  imageUrl: string | null
  itemName: string
  className?: string
}) {
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => setUnavailable(false), [imageUrl])

  if (imageUrl === null || unavailable) {
    return (
      <div
        className={`product-image-placeholder ${className}`.trim()}
        role="img"
        aria-label={`No image for ${itemName}`}
      >
        <span aria-hidden="true">DI</span>
      </div>
    )
  }

  return (
    <img
      className={`product-image ${className}`.trim()}
      src={imageUrl}
      alt={`${itemName} reference`}
      onError={() => setUnavailable(true)}
    />
  )
}
