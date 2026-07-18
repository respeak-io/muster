// Parsing for the working-set diff viewer. The backend (git_diff) hands us one
// combined unified-diff patch; we turn it into per-file records here rather than
// in Rust, keeping that side thin. Kept in its own module (no DOM/Tauri imports)
// so it can be unit-tested in isolation — see test/diff.test.ts.

export interface DiffLine { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null; }
export interface DiffHunk { header: string; lines: DiffLine[]; }
export interface DiffFile { path: string; oldPath: string | null; status: "modified" | "added" | "deleted" | "renamed"; binary: boolean; added: number; removed: number; hunks: DiffHunk[]; }

// Parse a combined unified diff into per-file records. Robust to spaces in paths
// (we read the +++/--- headers, which git terminates with a tab, and fall back to
// the `diff --git`/rename lines), /dev/null sides for adds & deletes, and the
// "Binary files … differ" marker.
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;
  const strip = (p: string) => p.replace(/\t.*$/, "").replace(/^[ab]\//, "");
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: "", oldPath: null, status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
      hunk = null;
      files.push(cur);
      // Provisional name from the header; refined by the ---/+++ or rename lines.
      const m = line.slice(11).match(/^a\/(.*) b\/(.*)$/);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) { cur.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { cur.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { cur.oldPath = line.slice(12); cur.status = "renamed"; continue; }
    if (line.startsWith("rename to ")) { cur.path = line.slice(10); cur.status = "renamed"; continue; }
    if (line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("--- ")) { const p = line.slice(4); if (p !== "/dev/null") cur.oldPath = strip(p); continue; }
    if (line.startsWith("+++ ")) { const p = line.slice(4); if (p !== "/dev/null") cur.path = strip(p); continue; }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? +m[1] : 0;
      newNo = m ? +m[2] : 0;
      hunk = { header: m ? m[3].trim() : "", lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // index/mode/similarity headers between `diff --git` and the first @@
    const c = line[0];
    if (c === "+") { hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ }); cur.added++; }
    else if (c === "-") { hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null }); cur.removed++; }
    else if (c === " ") { hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); }
    // "\ No newline at end of file" and trailing blank lines fall through, ignored.
  }
  return files;
}
