import { protocol, type Session } from 'electron'
import { DENTAL_IMAGE_SCHEME, type ProductImageStore } from './product-image-store'

export function registerDentalImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DENTAL_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
      }
    }
  ])
}

export function registerDentalImageProtocol(
  electronSession: Session,
  imageStore: ProductImageStore
): () => void {
  electronSession.protocol.handle(DENTAL_IMAGE_SCHEME, async (request) => {
    const image = await imageStore.readManagedImageRequest(request.url)
    if (image === null) {
      return new Response(null, {
        status: 404,
        headers: { 'X-Content-Type-Options': 'nosniff' }
      })
    }

    return new Response(new Uint8Array(image.body), {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=3600',
        'Content-Type': image.mimeType,
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  return () => electronSession.protocol.unhandle(DENTAL_IMAGE_SCHEME)
}
