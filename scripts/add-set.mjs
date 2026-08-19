#!/usr/bin/env node
// Fetches one or more LEGO sets' non-spare parts and minifigures from
// Rebrickable and writes parts/<set_num>.json, minifig_parts/<fig_num>.json,
// and updates index.json, matching what the missing-piece widget expects.
//
// Run by .github/workflows/add-set.yml — expects REBRICKABLE_API_KEY and
// SET_NUMBERS (comma/newline/space separated, e.g. "10218, 21363") as
// environment variables. Sets are processed one at a time; if one fails,
// it's logged as a warning and the rest still run.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const API_KEY = process.env.REBRICKABLE_API_KEY;
const RAW_SET_NUMBERS = process.env.SET_NUMBERS;

if (!API_KEY) {
  console.error("Missing REBRICKABLE_API_KEY");
  process.exit(1);
}
if (!RAW_SET_NUMBERS) {
  console.error("Missing SET_NUMBERS");
  process.exit(1);
}

const SET_NUMBERS = [
  ...new Set(
    RAW_SET_NUMBERS
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  ),
];

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

async function processSet(rawSetNumber) {
  const setNum = rawSetNumber.includes("-") ? rawSetNumber.split("-")[0] : rawSetNumber;
  const rebrickableSetId = rawSetNumber.includes("-") ? rawSetNumber : `${rawSetNumber}-1`;

  console.log(`\n=== ${rebrickableSetId} ===`);

  const setInfo = await rebrickableGet(`/sets/${rebrickableSetId}/`);
  const setName = setInfo.name;

  const rawParts = await rebrickableGet(`/sets/${rebrickableSetId}/parts/`);
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

  const rawMinifigs = await rebrickableGet(`/sets/${rebrickableSetId}/minifigs/`);
  const minifigs = rawMinifigs.map((m) => ({
    id: m.set_num,
    fig_num: m.set_num,
    name: m.set_name,
    max_qty: m.quantity,
    img: m.set_img_url || "",
    label: `${m.set_num} \u2014 ${m.set_name} (Minifigure)`,
  }));

  await mkdir("parts", { recursive: true });
  const setJsonPath = `parts/${setNum}.json`;
  await writeFile(
    setJsonPath,
    JSON.stringify({ set_num: setNum, set_name: setName, parts, minifigs }, null, 2)
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

  return { set_num: setNum, set_name: setName, part_count: parts.length, minifig_count: minifigs.length };
}

async function main() {
  console.log(`Processing ${SET_NUMBERS.length} set(s): ${SET_NUMBERS.join(", ")}`);

  const succeeded = [];
  const failed = [];

  for (const rawSetNumber of SET_NUMBERS) {
    try {
      succeeded.push(await processSet(rawSetNumber));
    } catch (err) {
      console.log(`::warning::Failed on set ${rawSetNumber}: ${err.message}`);
      failed.push(rawSetNumber);
    }
  }

  if (succeeded.length > 0) {
    const indexPath = "index.json";
    let index = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, "utf8")) : [];
    for (const result of succeeded) {
      index = index.filter((s) => s.set_num !== result.set_num);
      index.push(result);
    }
    index.sort((a, b) => a.set_num.localeCompare(b.set_num, undefined, { numeric: true }));
    await writeFile(indexPath, JSON.stringify(index));
    console.log(`\nUpdated index.json (${index.length} sets total)`);
  }

  console.log(`\nDone: ${succeeded.length} succeeded, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log(`::warning::Sets that failed and were skipped: ${failed.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
