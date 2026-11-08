import { mkdir, readFile, writeFile } from "node:fs/promises";

// Copies the browser build of @vercel/analytics into public/ so it ships with
// the static site (Vercel only packages data/, public/ and src/). Rerun after
// upgrading the package: npm run vendor
const source = await readFile("node_modules/@vercel/analytics/dist/index.mjs", "utf8");
const { version, license } = JSON.parse(await readFile("node_modules/@vercel/analytics/package.json", "utf8"));
await mkdir("public/vendor", { recursive: true });
await writeFile("public/vendor/vercel-analytics.mjs", `// @vercel/analytics ${version} (${license}), copied by \x60npm run vendor\x60. Do not edit.\n${source}`);
console.log(`vendored @vercel/analytics ${version}`);
