/**
 * Copy static web assets (src/web/*) into dist/web/ after tsgo build.
 * tsgo only emits .ts files, so the HTML/CSS/JS page must be copied.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "web");
const dist = join(root, "dist", "web");

mkdirSync(dist, { recursive: true });
rmSync(dist, { recursive: true });
cpSync(src, dist, { recursive: true });
console.log(`copied ${src} -> ${dist}`);
