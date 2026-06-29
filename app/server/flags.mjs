import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

function flagsPath(dbDir) {
  return join(dbDir, "flags.json");
}

export function readFlags(dbDir) {
  try {
    const parsed = JSON.parse(readFileSync(flagsPath(dbDir), "utf8"));
    return Object.assign(Object.create(null), parsed);
  } catch {
    return Object.create(null);
  }
}

export function setFlag(dbDir, id, patch, now = new Date()) {
  const all = readFlags(dbDir);
  const prev = all[id] ?? { interesting: false, note: "" };
  const entry = {
    interesting: patch.interesting ?? prev.interesting,
    note: patch.note ?? prev.note,
    updated_at: now.toISOString(),
  };
  all[id] = entry;
  const path = flagsPath(dbDir);
  const tmp = path + ".tmp";
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, path);
  return entry;
}
