/**
 * @param {string} [platform]
 * @param {string} [architecture]
 * @returns {'linux-x64' | 'linux-arm64' | 'mac-x64' | 'mac-arm64'}
 */
export function publicationPlatformKey(
  platform = process.platform,
  architecture = process.arch,
) {
  if (architecture !== 'x64' && architecture !== 'arm64')
    throw new Error(`Unsupported publication architecture: ${architecture}`)
  const operatingSystem =
    platform === 'linux' ? 'linux' : platform === 'darwin' ? 'mac' : null
  if (!operatingSystem)
    throw new Error(`Unsupported publication operating system: ${platform}`)
  return `${operatingSystem}-${architecture}`
}
