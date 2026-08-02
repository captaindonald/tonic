'use strict';

/**
 * afterPack hook: signs the packaged app with CastLabs EVS production VMP keys.
 * electron-builder runs it from the "build.afterPack" key in package.json.
 *
 * VMP signing must happen BEFORE macOS code-signing, which is why this is an
 * afterPack hook and not afterSign. Without production VMP keys, Widevine
 * refuses DRM licences on macOS.
 * Linux does not enforce VMP so this hook is a no-op there.
 *
 * Local builds skip signing when both EVS credentials are absent. Tag builds
 * require both credentials, so an unsigned release cannot be published.
 *
 * Setup: read EVS_PACKAGE from build/evs.cjs, then run
 *        uvx --from <package> evs-account signup
 * Docs:  https://github.com/castlabs/electron-releases/wiki/EVS
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'win32') {
    return;
  }

  const { EVS_PACKAGE } = require('./evs.cjs');
  const { isOfficialBuild, validateCredentialPair } = require('../scripts/release-credentials.cjs');
  const credentialsAvailable = validateCredentialPair(
    process.env,
    'EVS_ACCOUNT_NAME',
    'EVS_PASSWD',
    isOfficialBuild(),
  );

  if (!credentialsAvailable) {
    console.log('EVS: Skipping VMP signing (credentials not available).');
    return;
  }

  const { execFileSync } = require('child_process');

  console.log('EVS: Signing package with production VMP keys...');
  try {
    execFileSync('uvx', ['--from', EVS_PACKAGE, 'evs-vmp', 'sign-pkg', appOutDir], {
      stdio: 'inherit',
    });
    console.log('EVS: VMP signing complete.');
  } catch (err) {
    console.error('EVS: VMP signing failed. Ensure castlabs_evs is installed:');
    console.error(`  uvx --from ${EVS_PACKAGE} evs-account signup`);
    throw err;
  }
};
