// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolveEsp32BaseUrl } from '../../src/main/hardware/hardware-configuration'

describe('ESP32 base URL configuration', () => {
  it('normalizes a configured local URL without hard-coding a fallback', () => {
    expect(
      resolveEsp32BaseUrl({ DENTAL_ESP32_BASE_URL: ' http://192.168.1.100/ ' })
    ).toBe('http://192.168.1.100')
    expect(resolveEsp32BaseUrl({})).toBeNull()
  })

  it.each([
    'not-a-url',
    'ftp://192.168.1.100',
    'http://user:password@192.168.1.100',
    'http://192.168.1.100?token=value'
  ])('rejects unsafe or invalid configuration: %s', (value) => {
    expect(resolveEsp32BaseUrl({ DENTAL_ESP32_BASE_URL: value })).toBeNull()
  })
})
