import * as Auto from "@auto-it/core";
import { makeHooks } from "@auto-it/core/dist/utils/make-hooks";
import { dummyLog } from "@auto-it/core/dist/utils/logger";
import { Helm } from "../src/helm";
import HelmPlugin, { IHelmPluginOptions } from "../src";
import Git from "@auto-it/core/dist/git";

const exec = jest.fn();

jest.mock("@auto-it/core/dist/utils/get-current-branch", () => ({
  getCurrentBranch: () => "next",
}));

jest.mock(
  "@auto-it/core/dist/utils/exec-promise",
  () =>
    (...args: unknown[]) =>
      exec(...args),
);

jest.mock("../src/helm");
const helmMocked = jest.mocked(Helm);

const setup = (
  mockGit?: Partial<Git>,
  options?: IHelmPluginOptions,
  checkEnv?: jest.SpyInstance,
  prereleaseBranches: string[] = ["next"],
) => {
  const plugin = new HelmPlugin(options || {});
  const hooks = makeHooks();

  plugin.apply({
    checkEnv,
    hooks,
    git: mockGit,
    remote: "origin",
    logger: dummyLog(),
    prefixRelease: (r: string) => r,
    config: { prereleaseBranches },
    getCurrentVersion: () => "v1.0.0",
  } as unknown as Auto.Auto);

  return hooks;
};

describe(HelmPlugin.name, () => {
  beforeEach(() => {
    helmMocked.mockClear();
    exec.mockClear();
  });

  describe("validateConfig", () => {
    it("should error without options", async () => {
      const hooks = setup();
      await expect(
        hooks.validateConfig.promise("helm", null),
      ).resolves.toHaveLength(1);
    });
  });

  describe("version", () => {
    // do nothing without git
    it("fails without git", async () => {
      const hooks = setup();
      await hooks.version.promise({ bump: Auto.SEMVER.patch });
    });

    // do nothing with bad bump
    it("fails with a invalid bump type", async () => {
      const hooks = setup({});
      await hooks.version.promise({ bump: "wrong" as Auto.SEMVER });
    });

    it("correctly labels valid bump", async () => {
      const hooks = setup({});
      await hooks.version.promise({ bump: Auto.SEMVER.patch });
    });
  });

  describe("next", () => {
    it("preps charts with correct version and repository", async () => {
      const hooks = setup(
        {
          getLastTagNotInBaseBranch: async () => "0.0.1",
          getLatestRelease: async () => "0.0.1",
        },
        { enablePreleases: true, repository: "dummy", push: true },
      );
      const res = await hooks.next.promise(["0.0.1"], {
        bump: Auto.SEMVER.patch,
      } as never);
      const helm = helmMocked.mock.instances[0];

      expect(helm.prepCharts).toBeCalledWith(
        "0.0.2-next.0",
        ".",
        "publish",
        expect.objectContaining({
          recursive: false,
          replaceFileWithRepository: false,
          replaceVersionToken: true,
          repository: "dummy",
        }),
      );
      expect(helm.publishCharts).toBeCalledWith("publish", "", false);

      expect(exec).toBeCalledTimes(2);
      expect(exec).toBeCalledWith("git", [
        "tag",
        "0.0.2-next.0",
        "-m",
        '"Tag pre-release: 0.0.2-next.0"',
      ]);
      expect(exec).toBeCalledWith("git", ["push", "origin", "next", "--tags"]);

      expect(res).toMatchObject(
        expect.arrayContaining(["0.0.1", "0.0.2-next.0"]),
      );
    });

    it("does not publish if push disabled", async () => {
      const hooks = setup(
        {
          getLastTagNotInBaseBranch: async () => "0.0.1",
          getLatestRelease: async () => "0.0.1",
        },
        { enablePreleases: true, push: false },
      );
      await hooks.next.promise(["0.0.1"], {
        bump: Auto.SEMVER.patch,
      } as never);
      const helm = helmMocked.mock.instances[0];

      expect(helm.publishCharts).not.toBeCalled();
    });

    it("returns default version if git not found", async () => {
      const hooks = setup();
      const res = await hooks.next.promise(["1234"], {} as never);
      expect(res).toMatchObject(expect.arrayContaining(["1234"]));
    });

    it("fails with bad version", async () => {
      const hooks = setup(
        {
          getLastTagNotInBaseBranch: async () => "invalid",
          getLatestRelease: async () => "invalid",
        },
        { enablePreleases: true },
      );
      const res = await hooks.next.promise(["invalid"], {
        bump: "wrong",
      } as never);
      expect(res).toMatchObject(
        expect.arrayContaining(["invalid", "prerelease"]),
      );
    });

    it("skips if prereleases disabled", async () => {
      const hooks = setup({}, { enablePreleases: false });
      await hooks.next.promise(["1234"], { bump: Auto.SEMVER.patch } as never);
      const helm = helmMocked.mock.instances[0];
      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
      expect(exec).not.toBeCalled();
    });
  });

  describe("publish", () => {
    it("fails without git", async () => {
      const hooks = setup();
      await hooks.publish.promise({} as never);
    });

    it("fails with invalid version", async () => {
      const hooks = setup({ getLatestTagInBranch: async () => "wrong" });
      await hooks.publish.promise({ bump: Auto.SEMVER.patch });
      const helm = helmMocked.mock.instances[0];

      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("fails with invalid bump", async () => {
      const hooks = setup({ getLatestTagInBranch: async () => "0.0.1" });
      await hooks.publish.promise({ bump: "wrong" } as never);
      const helm = helmMocked.mock.instances[0];

      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("skips if publishing not enabled", async () => {
      const hooks = setup(
        { getLatestTagInBranch: async () => "0.0.1" },
        { repository: "dummy", push: false },
      );
      await hooks.publish.promise({ bump: Auto.SEMVER.patch });

      const helm = helmMocked.mock.instances[0];

      expect(helm.prepCharts).toBeCalledWith(
        "0.0.2",
        ".",
        "publish",
        expect.objectContaining({
          recursive: false,
          replaceFileWithRepository: false,
          replaceVersionToken: true,
          repository: "dummy",
        }),
      );
      expect(helm.publishCharts).not.toBeCalled();
      expect(exec).not.toBeCalled();
    });

    it("preps chart with correct version and repository", async () => {
      const hooks = setup(
        { getLatestTagInBranch: async () => "0.0.1" },
        { repository: "dummy", push: true },
      );
      await hooks.publish.promise({ bump: Auto.SEMVER.patch });

      const helm = helmMocked.mock.instances[0];

      expect(helm.prepCharts).toBeCalledWith(
        "0.0.2",
        ".",
        "publish",
        expect.objectContaining({
          recursive: false,
          replaceFileWithRepository: false,
          replaceVersionToken: true,
          repository: "dummy",
        }),
      );
      expect(helm.publishCharts).toBeCalledWith("publish", "", false);

      expect(exec).toBeCalledTimes(2);
      expect(exec).toBeCalledWith("git", [
        "tag",
        "0.0.2",
        "-m",
        '"Update version to 0.0.2"',
      ]);
      expect(exec).toBeCalledWith("git", [
        "push",
        "--follow-tags",
        "--set-upstream",
        "origin",
        "next",
      ]);
    });
  });

  describe("beforeRun", () => {
    it("validates dependencies", async () => {
      const hooks = setup({});
      await hooks.beforeRun.promise({} as never);

      const helm = helmMocked.mock.instances[0];

      expect(helm.validateDependencies).toBeCalledTimes(1);
    });
  });

  describe("getPreviousVersion", () => {
    it("returns previous version", async () => {
      const hooks = setup({ getLatestTagInBranch: async () => "1.2.3" });
      const res = await hooks.getPreviousVersion.promise();
      expect(res).toBe("1.2.3");
    });

    it("fails without git", async () => {
      const hooks = setup();
      await expect(hooks.getPreviousVersion.promise()).rejects.toThrow();
    });
  });

  describe("canary", () => {
    it("fails without git", async () => {
      const hooks = setup();
      await hooks.canary.promise({} as never);
    });

    it("fails with invalid version bump", async () => {
      const hooks = setup(
        { getLatestRelease: async () => "0.0.1" },
        { enableCanary: true },
      );
      await hooks.canary.promise({
        bump: "wrong",
        canaryIdentifier: "canary",
      } as never);
      const helm = helmMocked.mock.instances[0];
      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("skips is canary disabled", async () => {
      const hooks = setup(
        { getLatestRelease: async () => "0.0.1" },
        { enableCanary: false },
      );
      await hooks.canary.promise({
        bump: "wrong",
        canaryIdentifier: "canary",
      } as never);
      const helm = helmMocked.mock.instances[0];
      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("skips is dryrun mode", async () => {
      const hooks = setup(
        { getLatestRelease: async () => "0.0.1" },
        { enableCanary: true },
      );
      await hooks.canary.promise({
        bump: Auto.SEMVER.patch as never,
        canaryIdentifier: "canary",
        dryRun: true,
      });
      const helm = helmMocked.mock.instances[0];
      expect(helm.prepCharts).not.toBeCalled();
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("skips publishing if push not enabled", async () => {
      const hooks = setup(
        { getLatestRelease: async () => "0.0.1" },
        { enableCanary: true, push: false },
      );
      await hooks.canary.promise({
        bump: Auto.SEMVER.patch,
        canaryIdentifier: "canary",
      } as never);
      const helm = helmMocked.mock.instances[0];
      expect(helm.publishCharts).not.toBeCalled();
    });

    it("preps chart with correct version and repository", async () => {
      const hooks = setup(
        { getLatestRelease: async () => "0.0.1" },
        { enableCanary: true, repository: "dummy", push: true },
      );
      await hooks.canary.promise({
        bump: Auto.SEMVER.patch,
        canaryIdentifier: "canary",
      } as never);
      const helm = helmMocked.mock.instances[0];
      expect(helm.prepCharts).toBeCalledWith(
        "1.0.1-canary",
        ".",
        "publish",
        expect.objectContaining({
          recursive: false,
          replaceFileWithRepository: false,
          replaceVersionToken: true,
          repository: "dummy",
        }),
      );
      expect(helm.publishCharts).toBeCalledWith("publish", "", false);
    });
  });
});
