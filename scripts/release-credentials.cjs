'use strict';

function isOfficialBuild(env = process.env) {
  return env.GITHUB_REF_TYPE === 'tag';
}

function validateCredentialPair(env, firstName, secondName, required = false) {
  const firstPresent = typeof env[firstName] === 'string' && env[firstName].trim() !== '';
  const secondPresent = typeof env[secondName] === 'string' && env[secondName].trim() !== '';

  if (firstPresent !== secondPresent) {
    throw new Error(`${firstName} and ${secondName} must be set together.`);
  }
  if (required && !firstPresent) {
    throw new Error(`${firstName} and ${secondName} are required for tag builds.`);
  }

  return firstPresent;
}

module.exports = { isOfficialBuild, validateCredentialPair };
