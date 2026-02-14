/**
 * SAFE FILE OPERATIONS — Atomic writes + Read-modify-write with implicit locking
 *
 * writeFileAtomic: Writes to a temp file, then renames. Prevents partial/corrupted
 * JSON if the process crashes mid-write or two writers overlap.
 *
 * readModifyWrite: Atomically reads, applies a transform, and writes back.
 * Uses a per-file in-memory lock (queued promises) to serialize concurrent
 * read-modify-write cycles within the same process.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Atomically write data to a file (write temp → rename).
 * @param {string} filePath - Absolute path to the target file
 * @param {*} data - Data to serialize (passed through JSON.stringify)
 */
function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, filePath);
}

// Per-file lock chains to serialize read-modify-write within one process
const _locks = new Map();

/**
 * Atomically read a JSON file, apply a transform, and write it back.
 * Serializes concurrent calls for the same file path.
 * @param {string} filePath - Absolute path to the JSON file
 * @param {Function} transform - (currentData) => newData
 * @param {*} defaultValue - Value to use if file doesn't exist or is corrupt
 */
function readModifyWrite(filePath, transform, defaultValue = {}) {
  // Chain on any in-flight operation for this file
  const prev = _locks.get(filePath) || Promise.resolve();
  const next = prev.then(() => {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      current = typeof defaultValue === "function" ? defaultValue() : defaultValue;
    }
    const updated = transform(current);
    writeFileAtomic(filePath, updated);
    return updated;
  }).catch(e => {
    console.error(`[SAFE-WRITE] readModifyWrite failed for ${path.basename(filePath)}: ${e.message}`);
  });
  _locks.set(filePath, next);
  return next;
}

module.exports = { writeFileAtomic, readModifyWrite };
