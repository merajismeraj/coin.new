// Builds the API as a Vercel Build Output API artifact (.vercel/output):
// one Node function serving every route, plus the cron that runs the jobs.
// Runs database migrations first when a database is configured.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel/output");
const fn = join(out, "functions/index.func");

const migrateUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (migrateUrl) {
  execFileSync("pnpm", ["--filter", "@coinnew/db", "migrate"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: migrateUrl } });
} else {
  console.warn("vercel-build: no DATABASE_URL; skipping migrations");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// Native modules can't be bundled; they're installed next to the bundle instead.
const NATIVE = ["@node-rs/argon2"];
await build({
  entryPoints: [join(root, "src/vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: NATIVE,
  // Some bundled CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

const apiPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = Object.fromEntries(NATIVE.map((n) => [n, apiPkg.dependencies[n]]));
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module", dependencies: deps }, null, 2));
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: fn, stdio: "inherit" });

writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);
writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "/(.*)", dest: "/index" }],
      // Every minute needs a paid Vercel plan; Hobby allows once a day (set CRON_SCHEDULE).
      crons: [{ path: "/internal/cron/tick", schedule: process.env.CRON_SCHEDULE || "* * * * *" }],
    },
    null,
    2,
  ),
);
console.log("vercel-build: wrote", out);
