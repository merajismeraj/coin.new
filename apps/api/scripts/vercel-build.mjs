// Builds the API as a Vercel Build Output API artifact (.vercel/output): one
// Node function serving every route. Before that, when a database is set:
// runs migrations, and on production builds schedules Supabase Cron (pg_cron +
// pg_net) to call /internal/cron/tick, which runs the background jobs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel/output");
const fn = join(out, "functions/index.func");

const env = process.env;
// Direct (non-pooled) connection for DDL. Supabase's Vercel integration names it POSTGRES_URL_NON_POOLING.
const directUrl = env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL || env.POSTGRES_URL;
if (directUrl) {
  execFileSync("pnpm", ["--filter", "@coinnew/db", "migrate"], { stdio: "inherit", env: { ...env, DATABASE_URL: directUrl } });
  // Production only: previews must not repoint the job at themselves.
  const tickUrl = env.CRON_TICK_URL || (env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/internal/cron/tick`);
  if (env.VERCEL_ENV === "production" && env.CRON_SECRET && tickUrl) {
    execFileSync("pnpm", ["--filter", "@coinnew/db", "schedule-cron"], { stdio: "inherit", env: { ...env, DATABASE_URL: directUrl, CRON_TICK_URL: tickUrl } });
  }
} else {
  console.warn("vercel-build: no DATABASE_URL; skipping migrations and cron");
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
    },
    null,
    2,
  ),
);
console.log("vercel-build: wrote", out);
