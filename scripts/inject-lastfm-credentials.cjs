// Writes assets/lastfm-credentials.json from the SIDRA_LASTFM_API_KEY and
// SIDRA_LASTFM_API_SECRET environment variables. It runs from npm's `prebuild`
// hook and from the `build` recipe in the justfile, because `npx tsc` fires no
// npm hook. In CI the env vars come from repository secrets.
//
// Local builds with no env set write an empty file rather than leaving it
// absent, because packaging fails when an asarUnpack entry is missing. Tag
// builds require both values, so official packages cannot lose Last.fm.
//
// An existing file that already holds credentials is left alone in a local
// build when the env is unset, so building without the vars does not blank a
// working setup.
//
// The output file is gitignored - the shared secret must never be committed to
// the source tree. The real secret ends up only in official build artefacts.
const fs = require("fs");
const path = require("path");
const { isOfficialBuild, validateCredentialPair } = require("./release-credentials.cjs");

const apiKey = process.env.SIDRA_LASTFM_API_KEY || "";
const apiSecret = process.env.SIDRA_LASTFM_API_SECRET || "";
const credentialsAvailable = validateCredentialPair(
  process.env,
  "SIDRA_LASTFM_API_KEY",
  "SIDRA_LASTFM_API_SECRET",
  isOfficialBuild()
);

const outPath = path.join(__dirname, "..", "assets", "lastfm-credentials.json");

function alreadyPopulated() {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return !!(existing.apiKey && existing.apiSecret);
  } catch {
    return false;
  }
}

if (!credentialsAvailable && alreadyPopulated()) {
  console.log("  ✓ Last.fm credentials kept (no env vars set)");
} else {
  fs.writeFileSync(
    outPath,
    JSON.stringify({ apiKey, apiSecret }, null, 2) + "\n"
  );

  console.log(
    credentialsAvailable
      ? "  ✓ Last.fm credentials injected"
      : "  ✓ Last.fm credentials file written empty (no env vars set)"
  );
}
