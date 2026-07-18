import { describe, it, expect } from "vitest";
import { parsePatch } from "../src/diff";

// Patches are built from real `git` output shapes. Lines are joined rather than
// written as template literals because diff bodies contain backticks and ${…}.
const patch = (...lines: string[]) => lines.join("\n");

describe("parsePatch", () => {
  it("returns [] for an empty or contentless patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("\n\n")).toEqual([]);
    expect(parsePatch("not a diff at all")).toEqual([]);
  });

  it("parses a modified file: counts, hunk, and per-line numbers", () => {
    const [f] = parsePatch(patch(
      "diff --git a/tracked.txt b/tracked.txt",
      "index 83db48f..e0c9b5e 100644",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+CHANGED",
      " line3",
      "+line4",
    ));
    expect(f.status).toBe("modified");
    expect(f.path).toBe("tracked.txt");
    expect(f.oldPath).toBe("tracked.txt");
    expect(f.binary).toBe(false);
    expect([f.added, f.removed]).toEqual([2, 1]);
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines).toEqual([
      { kind: "ctx", text: "line1", oldNo: 1, newNo: 1 },
      { kind: "del", text: "line2", oldNo: 2, newNo: null },
      { kind: "add", text: "CHANGED", oldNo: null, newNo: 2 },
      { kind: "ctx", text: "line3", oldNo: 3, newNo: 3 },
      { kind: "add", text: "line4", oldNo: null, newNo: 4 },
    ]);
  });

  it("parses an added file (path from +++, oldPath stays null) and keeps blank added lines", () => {
    const [f] = parsePatch(patch(
      "diff --git a/GUIDE.md b/GUIDE.md",
      "new file mode 100644",
      "index 0000000..f4a5322",
      "--- /dev/null",
      "+++ b/GUIDE.md",
      "@@ -0,0 +1,3 @@",
      "+# demo",
      "+",
      "+A small helper library.",
    ));
    expect(f.status).toBe("added");
    expect(f.path).toBe("GUIDE.md");
    expect(f.oldPath).toBeNull();
    expect([f.added, f.removed]).toEqual([3, 0]);
    expect(f.hunks[0].lines[1]).toEqual({ kind: "add", text: "", oldNo: null, newNo: 2 });
  });

  it("parses a deleted file (+++ is /dev/null, so path comes from the header)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "index 6d4d468..0000000",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-# demo",
      "-old readme",
    ));
    expect(f.status).toBe("deleted");
    expect(f.path).toBe("README.md");
    expect(f.oldPath).toBe("README.md");
    expect([f.added, f.removed]).toEqual([0, 2]);
  });

  it("handles paths with spaces and git's trailing-tab termination (untracked via --no-index)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/weird näme.txt b/weird näme.txt",
      "new file mode 100644",
      "index 0000000..26ff09d",
      "--- /dev/null",
      "+++ b/weird näme.txt\t", // git appends a tab when the path has spaces
      "@@ -0,0 +1 @@",
      '+a "quoted" line',
    ));
    expect(f.status).toBe("added");
    expect(f.path).toBe("weird näme.txt");
    expect(f.added).toBe(1);
    // single-line hunk header (no ,count) still yields correct line numbers
    expect(f.hunks[0].lines[0]).toEqual({ kind: "add", text: 'a "quoted" line', oldNo: null, newNo: 1 });
  });

  it("marks binary files and gives them no hunks", () => {
    const [f] = parsePatch(patch(
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "index 0000000..6164d9f",
      "Binary files /dev/null and b/bin.dat differ",
    ));
    expect(f.status).toBe("added");
    expect(f.binary).toBe(true);
    expect(f.path).toBe("bin.dat");
    expect(f.hunks).toHaveLength(0);
    expect([f.added, f.removed]).toEqual([0, 0]);
  });

  it("parses a pure rename (100% similarity, no ---/+++ or hunks)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
    ));
    expect(f.status).toBe("renamed");
    expect(f.path).toBe("new.txt");
    expect(f.oldPath).toBe("old.txt");
    expect(f.hunks).toHaveLength(0);
  });

  it("parses a rename with content changes (rename headers + a hunk)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/old.txt b/new.txt",
      "similarity index 60%",
      "rename from old.txt",
      "rename to new.txt",
      "index 1111111..2222222 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1,4 +1,5 @@",
      " aaaa",
      "-bbbb",
      "+CHANGED",
      " cccc",
      " dddd",
      "+eeee",
    ));
    expect(f.status).toBe("renamed");
    expect(f.path).toBe("new.txt");
    expect(f.oldPath).toBe("old.txt");
    expect([f.added, f.removed]).toEqual([2, 1]);
  });

  it("strips only the leading a//b/ prefix, so real paths under a dir named 'a' survive", () => {
    const [f] = parsePatch(patch(
      "diff --git a/a/weird.js b/a/weird.js",
      "index 1111111..2222222 100644",
      "--- a/a/weird.js",
      "+++ b/a/weird.js",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ));
    expect(f.path).toBe("a/weird.js");
    expect(f.oldPath).toBe("a/weird.js");
  });

  it("resets line numbers per hunk from each @@ header", () => {
    const [f] = parsePatch(patch(
      "diff --git a/multi.txt b/multi.txt",
      "index 1111111..2222222 100644",
      "--- a/multi.txt",
      "+++ b/multi.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,3 @@ fn context()",
      " j",
      "+K",
      " l",
    ));
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[1].header).toBe("fn context()"); // trailing @@ context is captured
    expect(f.hunks[1].lines[0]).toEqual({ kind: "ctx", text: "j", oldNo: 10, newNo: 10 });
    expect(f.hunks[1].lines[1]).toEqual({ kind: "add", text: "K", oldNo: null, newNo: 11 });
    expect(f.hunks[1].lines[2]).toEqual({ kind: "ctx", text: "l", oldNo: 11, newNo: 12 });
  });

  it("ignores the '\\ No newline at end of file' marker without counting it", () => {
    const [f] = parsePatch(patch(
      "diff --git a/nonl.txt b/nonl.txt",
      "index 1111111..2222222 100644",
      "--- a/nonl.txt",
      "+++ b/nonl.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ));
    expect([f.added, f.removed]).toEqual([1, 1]);
    expect(f.hunks[0].lines).toHaveLength(2); // the two "\ No newline" lines dropped
  });

  it("splits a combined multi-file patch into ordered per-file records", () => {
    const files = parsePatch(patch(
      "diff --git a/GUIDE.md b/GUIDE.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/GUIDE.md",
      "@@ -0,0 +1 @@",
      "+hi",
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/src/x.js b/src/x.js",
      "index 1111111..2222222 100644",
      "--- a/src/x.js",
      "+++ b/src/x.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ));
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["GUIDE.md", "added"],
      ["README.md", "deleted"],
      ["src/x.js", "modified"],
    ]);
  });
});
