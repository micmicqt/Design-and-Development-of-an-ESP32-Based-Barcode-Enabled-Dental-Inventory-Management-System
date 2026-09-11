const ESP32_BASE_URL_ENVIRONMENT_VARIABLE = 'DENTAL_ESP32_BASE_URL'
const ESP32_DEVICE_TOKEN_ENVIRONMENT_VARIABLE = 'DENTAL_DEVICE_TOKEN'
const DEVICE_TOKEN_PLACEHOLDER = 'replace-with-a-random-shared-device-token'

function containsHeaderUnsafeCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 32 || code === 127
  })
}

export function resolveEsp32BaseUrl(
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): string | null {
  const configuredValue = environment[ESP32_BASE_URL_ENVIRONMENT_VARIABLE]?.trim()
  if (configuredValue === undefined || configuredValue.length === 0) return null

  try {
    const parsed = new URL(configuredValue)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null
    }
    return configuredValue.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function resolveEsp32DeviceToken(
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): string | null {
  const configured = environment[ESP32_DEVICE_TOKEN_ENVIRONMENT_VARIABLE]?.trim()
  const token =
    configured !== undefined && configured.length >= 2 &&
    ((configured.startsWith('"') && configured.endsWith('"')) ||
      (configured.startsWith("'") && configured.endsWith("'")))
      ? configured.slice(1, -1).trim()
      : configured
  if (
    token === undefined ||
    token === DEVICE_TOKEN_PLACEHOLDER ||
    token.length < 32 ||
    token.length > 128 ||
    containsHeaderUnsafeCharacter(token)
  ) {
    return null
  }
  return token
}
