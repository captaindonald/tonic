import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ReleaseCredentials {
  isOfficialBuild(env?: NodeJS.ProcessEnv): boolean;
  validateCredentialPair(
    env: NodeJS.ProcessEnv,
    firstName: string,
    secondName: string,
    required?: boolean,
  ): boolean;
}

const { isOfficialBuild, validateCredentialPair } = require('../scripts/release-credentials.cjs') as ReleaseCredentials;
const { EVS_PACKAGE } = require('../build/evs.cjs') as { EVS_PACKAGE: string };
const afterPack = require('../build/afterPack.cjs').default as (context: {
  appOutDir: string;
  electronPlatformName: string;
}) => Promise<void>;
const builderWorkflow = readFileSync('.github/workflows/builder.yml', 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('release credential gates', () => {
  it('recognises GitHub tag builds as official', () => {
    expect(isOfficialBuild({ GITHUB_REF_TYPE: 'tag' })).toBe(true);
    expect(isOfficialBuild({ GITHUB_REF_TYPE: 'branch' })).toBe(false);
    expect(isOfficialBuild({})).toBe(false);
  });

  it('allows an unconfigured local build', () => {
    expect(validateCredentialPair({}, 'KEY', 'SECRET')).toBe(false);
  });

  it('rejects a partial credential pair', () => {
    expect(() => validateCredentialPair({ KEY: 'key' }, 'KEY', 'SECRET')).toThrow('KEY and SECRET must be set together');
    expect(() => validateCredentialPair({ SECRET: 'secret' }, 'KEY', 'SECRET')).toThrow(
      'KEY and SECRET must be set together',
    );
  });

  it('requires a complete pair for an official build', () => {
    expect(() => validateCredentialPair({}, 'KEY', 'SECRET', true)).toThrow(
      'KEY and SECRET are required for tag builds',
    );
    expect(validateCredentialPair({ KEY: 'key', SECRET: 'secret' }, 'KEY', 'SECRET', true)).toBe(true);
  });
});

describe('release build scripts', () => {
  it('allows an unsigned local EVS build', async () => {
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    vi.stubEnv('EVS_ACCOUNT_NAME', '');
    vi.stubEnv('EVS_PASSWD', '');

    await expect(afterPack({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'darwin' })).resolves.toBeUndefined();
  });

  it('fails EVS signing before packaging an unsigned tag build', async () => {
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    vi.stubEnv('EVS_ACCOUNT_NAME', '');
    vi.stubEnv('EVS_PASSWD', '');

    await expect(afterPack({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'darwin' })).rejects.toThrow(
      'EVS_ACCOUNT_NAME and EVS_PASSWD are required for tag builds',
    );
  });

  it('fails Last.fm injection before writing an unconfigured tag build', () => {
    const result = spawnSync(process.execPath, ['scripts/inject-lastfm-credentials.cjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_TYPE: 'tag',
        SIDRA_LASTFM_API_KEY: '',
        SIDRA_LASTFM_API_SECRET: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'SIDRA_LASTFM_API_KEY and SIDRA_LASTFM_API_SECRET are required for tag builds',
    );
  });
});

it('pins castlabs-evs to an exact release', () => {
  expect(EVS_PACKAGE).toMatch(/^castlabs-evs==\d+\.\d+\.\d+$/);
});

it('restricts Last.fm credentials to tag builds', () => {
  expect(builderWorkflow).toContain(
    "SIDRA_LASTFM_API_KEY: ${{ startsWith(github.ref, 'refs/tags/') && secrets.SIDRA_LASTFM_API_KEY || '' }}",
  );
  expect(builderWorkflow).toContain(
    "SIDRA_LASTFM_API_SECRET: ${{ startsWith(github.ref, 'refs/tags/') && secrets.SIDRA_LASTFM_API_SECRET || '' }}",
  );
});
