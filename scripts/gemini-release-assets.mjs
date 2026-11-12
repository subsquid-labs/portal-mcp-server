/*
 * `gemini extensions install https://github.com/subsquid-labs/portal-mcp-server`
 * downloads a release asset instead of cloning only when it can pick one:
 * a name starting with `<platform>.<arch>.` or `<platform>.`, or the release's
 * only asset. Releases also carry sqd.mcpb, so the generic archive alone is
 * never picked and Gemini clones the repository root, which has no manifest.
 * The same archive is therefore published once per platform.
 */
export const GEMINI_ARCHIVE = 'sqd.tar.gz'
export const GEMINI_PLATFORMS = ['darwin', 'linux', 'win32']

export function geminiReleaseAssetNames() {
  return [GEMINI_ARCHIVE, ...GEMINI_PLATFORMS.map((platform) => `${platform}.${GEMINI_ARCHIVE}`)]
}

/* Mirrors findReleaseAsset in @google/gemini-cli 0.68.0. */
export function geminiSelectsAsset(assetNames, platform, arch) {
  const names = assetNames.map((name) => name.toLowerCase())
  const platformArch = names.find((name) => name.startsWith(`${platform}.${arch}.`))
  if (platformArch) return platformArch
  const platformOnly = names.find((name) => name.startsWith(`${platform}.`))
  if (platformOnly) return platformOnly
  if (names.length !== 1) return undefined
  return names.find((name) => !['darwin', 'linux', 'win32'].some((os) => name.includes(os)))
}
