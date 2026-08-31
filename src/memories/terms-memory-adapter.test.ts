import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMS_MEMORY_NAME,
  TERMS_RETRIEVE_DESCRIPTION,
  TERMS_UPDATE_DESCRIPTION,
  TermsMemoryAdapter,
} from "./terms-memory-adapter.js";

describe("TermsMemoryAdapter", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "walle-terms-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("exposes aligned operation metadata and treats missing storage as empty", async () => {
    const adapter = new TermsMemoryAdapter(cwd);

    expect(adapter.retrieve.name).toBe(TERMS_MEMORY_NAME);
    expect(adapter.update.name).toBe(TERMS_MEMORY_NAME);
    expect(adapter.retrieve.description).toBe(TERMS_RETRIEVE_DESCRIPTION);
    expect(adapter.update.description).toBe(TERMS_UPDATE_DESCRIPTION);
    expect(adapter.retrieve("WallE")).toEqual({});
  });

  it("appends terms, preserves metadata on replacement, and retrieves exact terms", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(123).mockReturnValueOnce(456);
    const adapter = new TermsMemoryAdapter(cwd);

    await adapter.update('{"term":"WallE","definition":"旧定义"}');
    await adapter.update('{"term":"DIP","definition":"决策智能平台"}');
    await adapter.update('{"term":"walle","definition":"Agent 运行时框架"}');

    expect(adapter.retrieve("WALLE，dip")).toEqual({
      WallE: "Agent 运行时框架",
      DIP: "决策智能平台",
    });
    expect(adapter.retrieve('["dip", "missing"]')).toEqual({
      DIP: "决策智能平台",
    });
    expect(adapter.retrieve('"WallE"')).toEqual({
      WallE: "Agent 运行时框架",
    });
    expect(adapter.retrieve("WallE-extra")).toEqual({});
    expect(adapter.retrieve("  ")).toEqual({});
    expect(readFileSync(adapter.path, "utf8")).toBe([
      "WallE",
      "Agent 运行时框架",
      '{"created_at":123}',
      "---",
      "DIP",
      "决策智能平台",
      '{"created_at":456}',
      "",
    ].join("\n"));
  });

  it("supports whitespace-delimited multi-term retrieval and multiline definitions", async () => {
    const adapter = new TermsMemoryAdapter(cwd);
    mkdirSync(dirname(adapter.path), { recursive: true });
    writeFileSync(adapter.path, [
      "API",
      "应用程序",
      "编程接口",
      '{"created_at":1,"source":"user"}',
      "---",
      "SDK",
      "软件开发工具包",
      '{"created_at":2}',
      "",
    ].join("\n"));

    expect(adapter.retrieve("api SDK")).toEqual({
      API: "应用程序\n编程接口",
      SDK: "软件开发工具包",
    });
    await adapter.update('{"term":"API","definition":"新定义"}');
    expect(readFileSync(adapter.path, "utf8")).toContain(
      '{"created_at":1,"source":"user"}',
    );
  });

  it.each([
    ["malformed JSON", "not-json", "valid JSON"],
    ["wrong shape", '{"term":"WallE"}', "definition"],
    ["empty term", '{"term":" ","definition":"x"}', "too_small"],
  ])("rejects invalid update content: %s", async (_kind, content, message) => {
    expect(() => new TermsMemoryAdapter(cwd).update(content)).toThrow(message);
  });

  it.each([
    ["short entry", "WallE\ndefinition", "unsupported entry shape"],
    ["empty term", "\ndefinition\n{\"created_at\":1}", "unsupported entry shape"],
    ["empty definition", "WallE\n\n{\"created_at\":1}", "unsupported entry shape"],
    ["bad metadata JSON", "WallE\ndefinition\nnope", "malformed metadata"],
    ["bad metadata shape", "WallE\ndefinition\n{}", "created_at"],
  ])("rejects malformed storage: %s", async (_kind, markdown, message) => {
    const adapter = new TermsMemoryAdapter(cwd);
    mkdirSync(dirname(adapter.path), { recursive: true });
    writeFileSync(adapter.path, markdown);
    expect(() => adapter.retrieve("WallE")).toThrow(message);
  });

  it("propagates storage errors other than a missing file", async () => {
    const adapter = new TermsMemoryAdapter(cwd);
    mkdirSync(adapter.path, { recursive: true });
    expect(() => adapter.retrieve("WallE")).toThrow();
  });
});
