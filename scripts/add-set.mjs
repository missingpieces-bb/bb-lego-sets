#!/usr/bin/env node
// Fetches a LEGO set's non-spare parts and minifigures from Rebrickable
// and writes parts/<set_num>.json, minifig_parts/<fig_num>.json, and
// updates index.json, matching what the missing-piece widget expects.
//
// Run by .github/workflows/add-set.yml — expects REBRICKABLE_API_KEY and
// SET_NUMBER as environment variables.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const API_KEY = process.env.REBRICKABLE_API_KEY;
const RAW_SET_NUMBER = process.env.SET_NUMBER;

if (!API_KEY) {
  console.error("Missing REBRICKABLE_API_KEY");
  process.exit(1);
}
if (!RAW_SET_NUMBER) {
  console.error("Missing SET_NUMBER");
  process.exit(1);
}

// The repo stores bare set numbers ("10218"); Rebrickable's API wants
// the full identifier with its version suffix ("10218-1"). We assume
// version 1 unless one was already supplied.
const SET_NUM = RAW_SET_NUMBER.trim();
const REBRICKABLE_SET_ID = SET_NUM.includes("-") ? SET_NUM : `${SET_NUM}-1`;
const STORED_SET_NUM = SET_NUM.split("-")[0];

const API_ROOT = "https://rebrickable.com/api/v3/lego";

async function rebrickableGet(path) {
  let url = `${API_ROOT}${path}`;
  const results = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `key ${API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Rebrickable request failed (${res.status}): ${url}`);
    }
    const data = await res.json();
    if (Array.isArray(data.results)) {
      results.push(...data.results);
      url = data.next;
    } else {
      return data; // single-object endpoints (e.g. /sets/{id}/)
    }
  }
  return results;
}

function partId(partNum, colorId) {
  return `${partNum}-${colorId}`;
}

async function main() {
  console.log(`Fetching set ${REBRICKABLE_SET_ID}...`);

  const setInfo = await rebrickableGet(`/sets/${REBRICKABLE_SET_ID}/`);
  const setName = setInfo.name;

  const rawParts = await rebrickableGet(`/sets/${REBRICKABLE_SET_ID}/parts/`);
  const parts = rawParts
    .filter((p) => !p.is_spare)
    .map((p) => ({
      id: partId(p.part.part_num, p.color.id),
      part_num: p.part.part_num,
      name: p.part.name,
      color: p.color.name,
      max_qty: p.quantity,
      img: p.part_img_url || p.part.part_img_url || "",
      label: `${p.part.part_num} \u2014 ${p.part.name} (${p.color.name})`,
    }));

  const rawMinifigs = await rebrickableGet(`/sets/${REBRICKABLE_SET_ID}/minifigs/`);
  const minifigs = rawMinifigs.map((m) => ({
    id: m.set_num,
    fig_num: m.set_num,
    name: m.set_name,
    max_qty: m.quantity,
    img: m.set_img_url || "",
    label: `${m.set_num} \u2014 ${m.set_name} (Minifigure)`,
  }));

  await mkdir("parts", { recursive: true });
  const setJsonPath = `parts/${STORED_SET_NUM}.json`;
  await writeFile(
    setJsonPath,
    JSON.stringify({ set_num: STORED_SET_NUM, set_name: setName, parts, minifigs }, null, 2)
  );
  console.log(`Wrote ${setJsonPath} (${parts.length} parts, ${minifigs.length} minifigs)`);

  await mkdir("minifig_parts", { recursive: true });
  for (const fig of minifigs) {
    const outPath = `minifig_parts/${fig.fig_num}.json`;
    if (existsSync(outPath)) {
      console.log(`Skipping ${fig.fig_num}, already have a breakdown for it`);
      continue;
    }
    const rawFigParts = await rebrickableGet(`/minifigs/${fig.fig_num}/parts/`);
    const figParts = rawFigParts
      .filter((p) => !p.is_spare)
      .map((p) => ({
        part_num: p.part.part_num,
        name: p.part.name,
        color: p.color.name,
        qty: p.quantity,
        img: p.part_img_url || p.part.part_img_url || "",
      }));
    await writeFile(
      outPath,
      JSON.stringify({ fig_num: fig.fig_num, name: fig.name, parts: figParts }, null, 2)
    );
    console.log(`Wrote ${outPath} (${figParts.length} parts)`);
  }

  const indexPath = "index.json";
  const index = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, "utf8")) : [];
  const withoutThisSet = index.filter((s) => s.set_num !== STORED_SET_NUM);
  withoutThisSet.push({
    set_num: STORED_SET_NUM,
    set_name: setName,
    part_count: parts.length,
    minifig_count: minifigs.length,
  });
  withoutThisSet.sort((a, b) =>
    a.set_num.localeCompare(b.set_num, undefined, { numeric: true })
  );
  await writeFile(indexPath, JSON.stringify(withoutThisSet));
  console.log(`Updated index.json (${withoutThisSet.length} sets total)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
