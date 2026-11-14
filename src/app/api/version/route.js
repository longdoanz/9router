import pkg from "../../../../package.json" with { type: "json" };

// Update check disabled: this fork never contacts registry.npmjs.org.
// Upgrades are done by merging upstream and rebuilding the image.
export async function GET() {
  return Response.json({
    currentVersion: pkg.version,
    latestVersion: null,
    hasUpdate: false,
  });
}
