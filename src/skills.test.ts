import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Tools } from "./index.js";
import { ACTIVATE_SKILL_TOOL_NAME, Skills } from "./skills.js";

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
    expect(skills.catalog()).toBe("available_skills:");
    expect(() => skills.activate("missing")).toThrow('Unknown skill "missing"');
    await expect(new Tools([skills.activationTool()]).exec(
      ACTIVATE_SKILL_TOOL_NAME,
      '{"name":"missing"}',
    )).rejects.toThrow("name must be one of");
  });

  it("scans summaries in stable order and loads complete skill files on demand", async () => {
    const cwd = temporaryDirectory();
    const secondSource = "---\nname: second-skill\ndescription: |\n  第二个技能\n  可处理多行说明\nowner: team\n---\n\n# 私有执行步骤\n";
    const projectSkills = join(cwd, ".walle");
    createSkill(projectSkills, "second-skill", secondSource);
    createSkill(projectSkills, "first", "---\r\nname: first\r\ndescription: 第一个技能\r\n---\r\n正文\r\n");
    mkdirSync(join(projectSkills, "skills", "no-description"));
    writeFileSync(join(projectSkills, "skills", "README.md"), "ignored");

    const skills = new Skills(cwd, temporaryDirectory());
    const catalog = skills.catalog();

    expect([...skills.skills.keys()]).toEqual(["first", "second-skill"]);
    expect(skills.skills.get("second-skill")?.metadata.owner).toBe("team");
    expect(skills.skills.get("second-skill")?.location).toBe(
      join(cwd, ".walle", "skills", "second-skill", "SKILL.md"),
    );
    expect(catalog.indexOf("name: first")).toBeLessThan(catalog.indexOf("name: second-skill"));
    expect(catalog).toContain("description: 第二个技能 可处理多行说明");
    expect(catalog).not.toContain("私有执行步骤");
    expect(catalog).not.toContain("SKILL.md");
    expect(skills.activate("second-skill")).toBe("# 私有执行步骤");

    const tools = new Tools([skills.activationTool()]);
    expect(tools.list()[0]).toMatchObject({
      name: ACTIVATE_SKILL_TOOL_NAME,
      description: expect.stringContaining("available_skills:"),
    });
    expect(tools.list()[0]?.description).not.toContain(skills.skills.get("second-skill")?.location);
    await expect(tools.exec(
      ACTIVATE_SKILL_TOOL_NAME,
      '{"name":"second-skill"}',
    )).resolves.toBe("# 私有执行步骤");
  });

  it("merges all skill locations while preserving source priority", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    const localShared = "---\nname: shared\ndescription: cwd version\n---\nlocal";
    const stateShared = "---\nname: shared\ndescription: state version\n---\nstate";
    const globalShared = "---\nname: shared\ndescription: global version\n---\nglobal";
    const agentsShared = "---\nname: shared\ndescription: agents version\n---\nagents";
    createSkill(join(cwd, ".walle"), "shared", localShared);
    createSkill(join(cwd, ".agents"), "shared", stateShared);
    createSkill(join(cwd, ".agents"), "state-only", "---\nname: state-only\ndescription: state only\n---\nstate only body");
    createSkill(join(home, ".walle"), "shared", globalShared);
    createSkill(join(home, ".agents"), "shared", agentsShared);
    createSkill(join(home, ".walle"), "global-only", "---\nname: global-only\ndescription: global only\n---\n");
    createSkill(join(home, ".agents"), "agents-only", "---\nname: agents-only\ndescription: agents only\n---\n");

    const skills = new Skills(cwd, home);

    expect(skills.directories).toEqual([
      join(cwd, ".walle", "skills"),
      join(cwd, ".agents", "skills"),
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
    expect(skills.activate("shared")).toBe("local");
    expect(skills.catalog()).toContain("description: state only");
    expect(skills.catalog()).toContain("description: global only");
    expect(skills.catalog()).toContain("description: agents only");
    expect(skills.catalog()).not.toContain("state version");
    expect(skills.catalog()).not.toContain("global version");
    expect(skills.catalog()).not.toContain("agents version");
  });

  it.each([
    ["missing front matter", "plain text", "must start with YAML front matter"],
    ["invalid YAML", "---\nname: [broken\n---\n", "contains invalid YAML"],
    ["missing description", "---\nname: sample\n---\n", "must define non-empty name and description"],
    ["invalid name", "---\nname: Invalid_Name\ndescription: bad\n---\n", "must contain only lowercase"],
    ["mismatched name", "---\nname: another\ndescription: bad\n---\n", "must match directory name"],
  ])("rejects %s", (_label, source, message) => {
    const cwd = temporaryDirectory();
    createSkill(join(cwd, ".walle"), "sample", source);

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow(message);
  });

  it("does not hide skill-directory filesystem failures", () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, ".walle"));
    writeFileSync(join(cwd, ".walle", "skills"), "not a directory");

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow();
  });

  it("does not hide SKILL.md filesystem failures", () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, ".walle", "skills", "sample", "SKILL.md"), { recursive: true });

    expect(() => new Skills(cwd, temporaryDirectory())).toThrow();
  });
});
