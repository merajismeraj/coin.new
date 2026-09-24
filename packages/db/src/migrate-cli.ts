import postgres from "postgres";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1 });
const applied = await migrate({
  exec: async (text) => void (await sql.unsafe(text)),
  query: async (text, params) => (await sql.unsafe(text, params as never[])) as never,
});
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
await sql.end();
