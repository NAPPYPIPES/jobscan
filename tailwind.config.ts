import type { Config } from "tailwindcss";

// Tailwind v4 reads most config from CSS via @theme directives — see
// app/globals.css. This file is intentionally minimal; it exists so
// IDEs and the `tailwindcss` CLI can find the project root.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
};

export default config;
