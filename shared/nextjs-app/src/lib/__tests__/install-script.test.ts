import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { GET } from "@/app/api/install/route";

async function script(): Promise<string> {
  return (await GET()).text();
}

describe("/api/install script", () => {
  it("is valid bash", async () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "install-"));
    const file = path.join(dir, "install.sh");
    writeFileSync(file, await script());
    expect(() => execFileSync("bash", ["-n", file])).not.toThrow();
  });

  it("configures plain claude/codex instead of adding cc()/ccx() wrappers", async () => {
    const s = await script();
    expect(s).toContain('"${BIN_PATH}" setup');
    expect(s).toContain('"${BIN_PATH}" login');
    expect(s).not.toMatch(/^\s*ccx?\(\) \{/m);
  });

  it("removes the cc()/ccx() block an older install left in a shell rc file", async () => {
    const s = await script();
    const py = s.match(/<<'PYEOF'\n([\s\S]*?)\nPYEOF/)?.[1];
    expect(py).toBeDefined();
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "install-rc-"));
    const rc = path.join(dir, ".zshrc");
    const start = "# >>> cc-bedrock-local (ADR-014) >>>";
    const end = "# <<< cc-bedrock-local (ADR-014) <<<";
    writeFileSync(rc, `export A=1\n\n${start}\ncc() {\n  :\n}\n${end}\nexport B=2\n`);
    execFileSync("python3", ["-c", py!, rc, start, end]);
    expect(readFileSync(rc, "utf8")).toBe("export A=1\n\nexport B=2\n");
  });
});
