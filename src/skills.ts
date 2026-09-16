import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { FuncTool } from "./typings/tool.js";
import type {
  ActivateSkillArguments,
  SkillDefinition,
  SkillMetadata,
} from "./typings/skill.js";

/** Tool name reserved for activating discovered skill instructions. */
export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

const skillMetadataSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
}).passthrough();

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Registry of skill summaries discovered from prioritized skill directories. */
export class Skills {
  public readonly skills = new Map<string, SkillDefinition>();
  public readonly directories: readonly string[];

  /**
   * Scans skill packages from project, WallE, and shared agent directories.
   * @param cwd Agent working directory used to resolve project skill locations.
   * @param home User home directory used to resolve the global skill location.
   */
  public constructor(cwd: string = process.cwd(), home: string = homedir()) {
    this.directories = [
      resolve(cwd, ".walle", "skills"),
      resolve(cwd, ".agents", "skills"),
      resolve(home, ".walle", "skills"),
      resolve(home, ".agents", "skills"),
    ];
    for (const directory of this.directories) this.scan(directory);
  }

  /**
   * Loads only the instruction body for a discovered skill.
   * @param name Stable skill name selected by the model.
   * @returns Skill instructions with YAML front matter removed.
   */
  public activate(name: string): string {
    const skill = this.skills.get(name);
    if (skill === undefined) throw new Error(`Unknown skill "${name}"`);
    return parseSkill(readFileSync(skill.location, "utf8"), skill.location).instructions;
  }

  /**
   * Builds the catalog embedded in the skill activation tool description.
   * @returns Ordered skill names and descriptions without filesystem locations.
   */
  public catalog(): string {
    const list = [...this.skills.values()]
      .map(({ metadata }) => [
        `  - name: ${metadata.name}`,
        `    description: ${metadata.description.replace(/\s+/gu, " ").trim()}`,
      ].join("\n"))
      .join("\n");
    return `available_skills:${list === "" ? "" : `\n${list}`}`;
  }

  /**
   * Builds the model-callable tool used to activate skill instructions.
   * @returns Skill activator backed by this registry.
   */
  public activationTool(): FuncTool {
    const availableNames = [...this.skills.keys()];
    const parameters = z.object({
      name: z.string().refine(
        (name) => this.skills.has(name),
        { error: `name must be one of: ${availableNames.join(", ")}` },
      ).describe("要激活的技能名称"),
    }).strict();
    const registry = this;
    const activateSkill = function activate_skill(
      values: ActivateSkillArguments,
    ): string {
      return registry.activate(values.name);
    };
    return Object.assign(activateSkill, {
      description: `根据技能名称激活并返回对应的技能指令。\n\n${this.catalog()}`,
      parameters,
    });
  }

  /**
   * Scans direct child packages from one skill directory.
   * @param directory Skill directory at the current priority level.
   */
  private scan(directory: string): void {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (isMissingDirectoryError(error)) return;
      throw error;
    }

    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name, "SKILL.md");
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissingDirectoryError(error)) continue;
        throw error;
      }
      const metadata = parseSkill(source, path).metadata;
      if (!skillNamePattern.test(metadata.name)) {
        throw new Error(
          `Skill name "${metadata.name}" in ${path} must contain only lowercase letters, numbers, and single hyphens`,
        );
      }
      if (metadata.name !== entry.name) {
        throw new Error(
          `Skill name "${metadata.name}" in ${path} must match directory name "${entry.name}"`,
        );
      }
      if (!this.skills.has(metadata.name)) {
        this.skills.set(metadata.name, { metadata, location: resolve(path) });
      }
    }
  }
}

/**
 * Extracts YAML front matter and instructions from a skill description.
 * @param source Complete SKILL.md source.
 * @param path File path included in validation errors.
 * @returns Validated skill metadata and the instruction body.
 */
function parseSkill(
  source: string,
  path: string,
): { metadata: SkillMetadata; instructions: string } {
  const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`Skill file ${path} must start with YAML front matter`);
  }
  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch (error) {
    throw new Error(
      `Skill file ${path} contains invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = skillMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Skill file ${path} must define non-empty name and description fields`);
  }
  return {
    metadata: result.data,
    instructions: source.slice(match[0].length).trim(),
  };
}

/**
 * Identifies a missing file or directory without hiding other filesystem failures.
 * @param error Unknown filesystem error.
 * @returns Whether the error reports an absent path.
 */
function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
