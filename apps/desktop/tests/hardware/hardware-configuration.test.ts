// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  resolveEsp32BaseUrl,
  resolveEsp32DeviceToken
} from '../../src/main/hardware/hardware-configuration'

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

describe('ESP32 device-token configuration', () => {
  const validToken = 'a'.repeat(64)

  it('keeps a valid deployment token available only to Electron main', () => {
    expect(resolveEsp32DeviceToken({ DENTAL_DEVICE_TOKEN: ` ${validToken} ` })).toBe(
      validToken
    )
    expect(resolveEsp32DeviceToken({ DENTAL_DEVICE_TOKEN: `"${validToken}"` })).toBe(
      validToken
    )
    expect(resolveEsp32DeviceToken({ DENTAL_DEVICE_TOKEN: `'${validToken}'` })).toBe(
      validToken
    )
  })

  it.each([
    undefined,
    '',
    'short',
    'replace-with-a-random-shared-device-token',
    `valid-looking-${'a'.repeat(30)}\nheader-injection`,
    'a'.repeat(129)
  ])('rejects an absent, placeholder, or unsafe token %#', (value) => {
    expect(
      resolveEsp32DeviceToken(value === undefined ? {} : { DENTAL_DEVICE_TOKEN: value })
    ).toBeNull()
  })
})
