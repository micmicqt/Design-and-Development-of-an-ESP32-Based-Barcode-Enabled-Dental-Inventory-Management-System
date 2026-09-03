const ESP32_BASE_URL_ENVIRONMENT_VARIABLE = 'DENTAL_ESP32_BASE_URL'

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
