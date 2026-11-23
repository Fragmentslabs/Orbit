import { describe, expect, it } from "vitest";
import { isNotRepoError } from "./git-errors";

describe("isNotRepoError", () => {
  it("recognizes git's message for a folder without a repository", () => {
    expect(
      isNotRepoError(
        "Command failed: git status --porcelain -z\nfatal: not a git repository (or any of the parent directories): .git",
      ),
    ).toBe(true);
    expect(isNotRepoError("fatal: Not a git repository")).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isNotRepoError("fatal: bad revision 'HEAD'")).toBe(false);
    expect(isNotRepoError("")).toBe(false);
  });
});
