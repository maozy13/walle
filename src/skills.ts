import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { FuncTool } from "./typings/tool.js";
import type {
  ReadFullSkillArguments,
  SkillDefinition,
  SkillMetadata,
} from "./typings/skill.js";

/** Tool name reserved for loading complete skill instructions. */
export const READ_FULL_SKILL_TOOL_NAME = "read_full_skill";

const skillMetadataSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
}).passthrough();

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Registry of skill summaries discovered from a working directory. */
export class Skills {
  public readonly skills = new Map<string, SkillDefinition>();
  public readonly directory: string;

  /**
   * Scans skill packages under a working directory.
   * @param cwd Working directory whose skills subdirectory contains skill packages.
   */
  public constructor(cwd: string = process.cwd()) {
    this.directory = resolve(cwd, "skills");
    this.scan();
  }

  /**
   * Reads the complete SKILL.md content for a discovered skill.
   * @param name Stable skill name selected by the model.
   * @returns Complete skill description including its front matter.
   */
  public read(name: string): string {
    const skill = this.skills.get(name);
    if (skill === undefined) throw new Error(`Unknown skill "${name}"`);
    return readFileSync(skill.path, "utf8");
  }

  /**
   * Builds the system instructions that advertise discovered skill summaries.
   * @returns Skill usage rules and the ordered list of available skills.
   */
  public instructions(): string {
    if (this.skills.size === 0) return "";
    const list = [...this.skills.values()]
      .map(({ metadata }) => `- name: ${metadata.name}\n  description: ${metadata.description}`)
      .join("\n");
    return `# 使用技能

## 使用规则

根据技能的 \`name\` 和 \`description\` 判断当前任务是否需要使用技能，如果有合适的技能：

1. 使用 \`${READ_FULL_SKILL_TOOL_NAME}()\` 工具读取完整的技能描述。
2. 判断技能的描述是否能够满足任务需求：
   2.1 如果能，则按照技能描述执行技能。
3. 根据需要，你可以一次加载多个技能，也可以在技能执行过程中按需加载其他技能。

## 技能列表

以下是可用的技能：
${list}`;
  }

  /**
   * Builds the model-callable tool used to load complete skill instructions.
   * @returns Full-skill reader backed by this registry.
   */
  public readTool(): FuncTool {
    const availableNames = [...this.skills.keys()];
    const parameters = z.object({
      name: z.string().refine(
        (name) => this.skills.has(name),
        { error: `name must be one of: ${availableNames.join(", ")}` },
      ).describe("要读取的技能名称"),
    }).strict();
    const registry = this;
    const readFullSkill = function read_full_skill(
      values: ReadFullSkillArguments,
    ): string {
      return registry.read(values.name);
    };
    return Object.assign(readFullSkill, {
      description: "根据技能名称读取完整的 SKILL.md 技能说明。",
      parameters,
    });
  }

  /** Scans direct child packages and validates every discovered SKILL.md file. */
  private scan(): void {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(this.directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (isMissingDirectoryError(error)) return;
      throw error;
    }

    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(this.directory, entry.name, "SKILL.md");
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissingDirectoryError(error)) continue;
        throw error;
      }
      const metadata = parseMetadata(source, path);
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
      this.skills.set(metadata.name, { metadata, path });
    }
  }
}

/**
 * Extracts and validates YAML front matter from a skill description.
 * @param source Complete SKILL.md source.
 * @param path File path included in validation errors.
 * @returns Validated skill metadata, including user-defined fields.
 */
function parseMetadata(source: string, path: string): SkillMetadata {
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
  return result.data;
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
