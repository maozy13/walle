import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Tools } from "./index.js";
import { READ_FULL_SKILL_TOOL_NAME, Skills } from "./skills.js";

/** Creates one test skill package. */
function createSkill(
  cwd: string,
  directory: string,
  source: string,
): string {
  const packageDirectory = join(cwd, "skills", directory);
  mkdirSync(packageDirectory, { recursive: true });
  const path = join(packageDirectory, "SKILL.md");
  writeFileSync(path, source);
  return path;
}

describe("Skills", () => {
  const directories: string[] = [];

  /** Creates and tracks an isolated working directory. */
  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "walle-skills-"));
    directories.push(directory);
    return directory;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an absent skill directory as an empty registry", async () => {
    const skills = new Skills(temporaryDirectory(), temporaryDirectory());

    expect(skills.skills.size).toBe(0);
    expect(skills.instructions()).toBe("");
    expect(() => skills.read("missing")).toThrow('Unknown skill "missing"');
    await expect(new Tools([skills.readTool()]).exec(
      READ_FULL_SKILL_TOOL_NAME,
      '{"name":"missing"}',
    )).rejects.toThrow("name must be one of");
  });

  it("scans summaries in stable order and loads complete skill files on demand", async () => {
    const cwd = temporaryDirectory();
    const secondSource = "---\nname: second-skill\ndescription: |\n  第二个技能\n  可处理多行说明\nowner: team\n---\n\n# 私有执行步骤\n";
    createSkill(cwd, "second-skill", secondSource);
    createSkill(cwd, "first", "---\r\nname: first\r\ndescription: 第一个技能\r\n---\r\n正文\r\n");
    mkdirSync(join(cwd, "skills", "no-description"));
    writeFileSync(join(cwd, "skills", "README.md"), "ignored");

    const skills = new Skills(cwd, temporaryDirectory());
    const instructions = skills.instructions();

    expect([...skills.skills.keys()]).toEqual(["first", "second-skill"]);
    expect(skills.skills.get("second-skill")?.metadata.owner).toBe("team");
    expect(instructions.indexOf("name: first")).toBeLessThan(
      instructions.indexOf("name: second-skill"),
    );
    expect(instructions).toContain("使用 `read_full_skill()` 工具");
    expect(instructions).toContain("第二个技能\n可处理多行说明");
    expect(instructions).not.toContain("私有执行步骤");
    expect(skills.read("second-skill")).toBe(secondSource);

    const tools = new Tools([skills.readTool()]);
    expect(tools.list()[0]).toMatchObject({
      name: READ_FULL_SKILL_TOOL_NAME,
      description: expect.stringContaining("SKILL.md"),
    });
    await expect(tools.exec(
      READ_FULL_SKILL_TOOL_NAME,
      '{"name":"second-skill"}',
    )).resolves.toBe(secondSource);
  });

  it("merges all skill locations while preserving source priority", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    const localShared = "---\nname: shared\ndescription: cwd version\n---\nlocal";
    const stateShared = "---\nname: shared\ndescription: state version\n---\nstate";
    const globalShared = "---\nname: shared\ndescription: global version\n---\nglobal";
    const agentsShared = "---\nname: shared\ndescription: agents version\n---\nagents";
    createSkill(cwd, "shared", localShared);
    createSkill(join(cwd, ".walle"), "shared", stateShared);
    createSkill(join(home, ".walle"), "shared", globalShared);
    createSkill(join(home, ".agents"), "shared", agentsShared);
    createSkill(join(cwd, ".walle"), "state-only", "---\nname: state-only\ndescription: state only\n---\n");
    createSkill(join(home, ".walle"), "global-only", "---\nname: global-only\ndescription: global only\n---\n");
    createSkill(join(home, ".agents"), "agents-only", "---\nname: agents-only\ndescription: agents only\n---\n");

    const skills = new Skills(cwd, home);

    expect(skills.directories).toEqual([
      join(cwd, "skills"),
      join(cwd, ".walle", "skills"),
      join(home, ".walle", "skills"),
      join(home, ".agents", "skills"),
    ]);
    expect([...skills.skills.keys()]).toEqual([
      "shared",
      "state-only",
      "global-only",
      "agents-only",
    ]);
    expect(skills.skills.get("shared")?.metadata.description).toBe("cwd version");
    expect(skills.read("shared")).toBe(localShared);
    expect(skills.instructions()).toContain("description: state only");
    expect(skills.instructions()).toContain("description: global only");
    expect(skills.instructions()).toContain("description: agents only");
    expect(skills.instructions()).not.toContain("state version");
    expect(skills.instructions()).not.toContain("global version");
    expect(skills.instructions()).not.toContain("agents version");
  });

  it.each([
    ["missing front matter", "plain text", "must start with YAML front matter"],
    ["invalid YAML", "---\nname: [broken\n---\n", "contains invalid YAML"],
    ["missing description", "---\nname: sample\n---\n", "must define non-empty name and description"],
    ["invalid name", "---\nname: Invalid_Name\ndescription: bad\n---\n", "must contain only lowercase"],
    ["mismatched name", "---\nname: another\ndescription: bad\n---\n", "must match directory name"],
  ])("rejects %s", (_label, source, message) => {
    const cwd = temporaryDirectory();
    createSkill(cwd, "sample", source);

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow(message);
  });

  it("does not hide skill-directory filesystem failures", () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, "skills"), "not a directory");

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow();
  });

  it("does not hide SKILL.md filesystem failures", () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, "skills", "sample", "SKILL.md"), { recursive: true });

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow();
  });
});
