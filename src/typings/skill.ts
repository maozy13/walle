/** Metadata extracted from a skill package's YAML front matter. */
export interface SkillMetadata {
  /** Stable skill name, which must match the package directory name. */
  name: string;
  /** Model-facing guidance describing when the skill should be loaded. */
  description: string;
  /** Optional user-defined front matter fields. */
  [key: string]: unknown;
}

/** A discovered skill package and the location of its complete instructions. */
export interface SkillDefinition {
  /** Parsed YAML front matter. */
  metadata: SkillMetadata;
  /** Absolute path to the package's SKILL.md file. */
  path: string;
}

/** Arguments accepted by the built-in full-skill reader. */
export interface ReadFullSkillArguments {
  /** Name of the discovered skill to read. */
  name: string;
}
