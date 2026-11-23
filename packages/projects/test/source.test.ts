import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportError, folderNameFromUrl, parseSource, validateLocalPath } from "../src/source.js";

const repoish = () => {
  const dir = mkdtempSync(join(tmpdir(), "imp-"));
  mkdirSync(join(dir, ".git"));
  return dir;
};
const isRepo = async (dir: string) => dir.endsWith("-repo") || dir.includes("imp-");
const ctx = (over: Partial<Parameters<typeof validateLocalPath>[1]> = {}) => ({
  profile: "personal",
  home: "/home/me",
  forbiddenRoots: ["/srv/daedalus", "/srv/daedalus-data"],
  isRepo,
  ...over,
});

describe("parseSource", () => {
  it("recognises absolute paths, WSL UNC paths, Windows drive paths, https and scp-style URLs", () => {
    expect(parseSource("/home/me/projects/app")).toEqual({ kind: "path", path: "/home/me/projects/app" });
    expect(parseSource("\\\\wsl.localhost\\Ubuntu\\home\\me\\work\\app")).toEqual({
      kind: "path",
      path: "/home/me/work/app",
    });
    expect(parseSource("\\\\wsl$\\Ubuntu\\home\\me\\app")).toEqual({ kind: "path", path: "/home/me/app" });
    expect(parseSource("C:\\Users\\me\\app")).toEqual({ kind: "path", path: "/mnt/c/Users/me/app" });
    expect(parseSource("~/work/app", { home: "/home/me" })).toEqual({ kind: "path", path: "/home/me/work/app" });
    expect(parseSource(" https://github.com/me/app.git ")).toEqual({ kind: "url", url: "https://github.com/me/app.git" });
    expect(parseSource("git@gitlab.com:team/app.git")).toEqual({ kind: "url", url: "git@gitlab.com:team/app.git" });
  });

  it("rejects relative paths, ~ without home, empty input and other schemes", () => {
    for (const bad of ["", "   ", "app", "./app", "../app", "~/app", "file:///etc", "ext::sh -c x", "-oProxyCommand=x"]) {
      expect(() => parseSource(bad), bad).toThrow(ImportError);
    }
  });

  it("rejects absurdly long input", () => {
    expect(() => parseSource("/" + "a".repeat(5000))).toThrow(ImportError);
  });
});

describe("folderNameFromUrl", () => {
  it("takes the repo name, lowercased and safe", () => {
    expect(folderNameFromUrl("https://github.com/me/My-App.git")).toBe("my-app");
    expect(folderNameFromUrl("git@gitlab.com:team/sub/Bilyo")).toBe("bilyo");
    expect(folderNameFromUrl("https://github.com/me/app/")).toBe("app");
  });

  it("never returns something that escapes the clone root or is hidden", () => {
    for (const url of ["https://github.com/me/..", "https://github.com/me/.git", "https://github.com/me/%2e%2e", "https://github.com/me/.hidden"]) {
      const name = (() => {
        try {
          return folderNameFromUrl(url);
        } catch {
          return null;
        }
      })();
      if (name !== null) {
        expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
        expect(name).not.toBe("..");
      }
    }
  });
});

describe("validateLocalPath", () => {
  it("accepts a git repo and returns its real path", async () => {
    const dir = repoish();
    await expect(validateLocalPath(dir, ctx())).resolves.toBe(dir);
  });

  it("resolves symlinks before checking, so a link can't smuggle in a forbidden folder", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "lnk-")), "to-root");
    symlinkSync("/", link);
    await expect(validateLocalPath(link, ctx())).rejects.toThrow(/root|system/i);
  });

  it("rejects missing folders, files and non-repos", async () => {
    await expect(validateLocalPath("/definitely/not/here", ctx())).rejects.toThrow(/doesn't exist/);
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    await expect(validateLocalPath(plain, ctx())).rejects.toThrow(/git repo/);
  });

  it("rejects /, the home folder itself and Daedalus's own folders", async () => {
    await expect(validateLocalPath("/", ctx())).rejects.toThrow(ImportError);
    const home = repoish();
    await expect(validateLocalPath(home, ctx({ home }))).rejects.toThrow(/home folder/);
    const own = repoish();
    await expect(validateLocalPath(join(own), ctx({ forbiddenRoots: [own] }))).rejects.toThrow(/Daedalus/);
    const inner = join(own, "sub-repo");
    mkdirSync(inner);
    await expect(validateLocalPath(inner, ctx({ forbiddenRoots: [own] }))).rejects.toThrow(/Daedalus/);
  });

  it("keeps Work repos off the Windows drives (/mnt/...)", async () => {
    await expect(validateLocalPath("/mnt/c/Users/me/app", ctx({ profile: "work", realpath: async (p: string) => p, statDir: async () => true }))).rejects.toThrow(/WSL/);
  });
});
