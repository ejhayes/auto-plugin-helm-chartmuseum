import { ILogger } from "@auto-it/core";
import { Helm } from "../src/helm";
import { rm, mkdir, cp, readdir } from "fs/promises";
import { Dirent } from "fs";

const exec = jest.fn();
const logger = jest.fn(() => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
})) as jest.Mock<ILogger>;

jest.mock("fs/promises");

jest.mock(
  "@auto-it/core/dist/utils/exec-promise",
  () =>
    (...args: unknown[]) =>
      exec(...args)
);

describe(Helm.name, () => {
  let helm: Helm;

  beforeEach(() => {
    logger.mockClear();
    exec.mockClear();
    helm = new Helm(logger(), {});
  });

  describe("prepChart", () => {
    beforeEach(() => {
      jest.spyOn(helm, "inlineReplace").mockImplementation(jest.fn());
      jest
        .spyOn(helm, "findMatchingChartFiles")
        .mockResolvedValue(["dummyfile"]);
    });

    it("works", async () => {
      await helm.prepChart("src", "dest", "1234", {
        recursive: true,
        replaceFileWithRepository: true,
        replaceVersionToken: true,
        repository: "testrepo",
      });
      expect(exec).toBeCalledWith("helm", ["dep", "up", "src"]);
      expect(exec).toBeCalledWith("helm", ["package", "src", "-d", "dest"]);

      expect(rm).toBeCalledWith("src/charts/*.tgz", {
        force: true,
        recursive: true,
      });

      expect(helm.inlineReplace).toBeCalledTimes(1);
    });

    it("replaces correct repository", async () => {
      const replacerFn = jest.fn();
      jest
        .spyOn(helm, "inlineReplace")
        .mockImplementation(async (path, replacers) => {
          replacerFn(
            replacers(
              `test:  file://../some/path\nkey2:     file://../../otherPath`
            )
          );
        });
      await helm.prepChart("src", "dest", "1234", {
        recursive: true,
        replaceFileWithRepository: true,
        replaceVersionToken: true,
        repository: "testrepo",
      });
      expect(replacerFn).toBeCalledTimes(1);
      expect(replacerFn).toBeCalledWith(
        `test:  'testrepo'\nkey2:     'testrepo'`
      );
    });

    it("does not replace repository if disabled", async () => {
      await helm.prepChart("src", "dest", "1234", {
        recursive: true,
        replaceFileWithRepository: false,
        replaceVersionToken: true,
        repository: "testrepo",
      });
      expect(helm.inlineReplace).not.toBeCalled();
    });

    it("does not replace repository if repository token not provided", async () => {
      await helm.prepChart("src", "dest", "1234", {
        recursive: true,
        replaceFileWithRepository: true,
        replaceVersionToken: true,
      });
      expect(helm.inlineReplace).not.toBeCalled();
    });
  });

  describe("publishCharts", () => {
    it("works", async () => {
      jest
        .mocked(readdir)
        .mockResolvedValueOnce([
          { name: "someChart.tgz", isFile: () => true } as Dirent,
        ]);

      await helm.publishCharts("path", "repo", true);

      expect(exec).toBeCalledWith("helm", [
        "cm-push",
        "-f",
        "path/someChart.tgz",
        "repo",
      ]);
    });

    it("skips non tgz files and directories", async () => {
      jest
        .mocked(readdir)
        .mockResolvedValueOnce([
          { name: "someFile", isFile: () => true } as Dirent,
          { name: "someDir", isFile: () => false } as Dirent,
          { name: "someChart.tgz", isFile: () => true } as Dirent,
        ]);

      await helm.publishCharts("path", "repo", true);

      expect(exec).toBeCalledWith("helm", [
        "cm-push",
        "-f",
        "path/someChart.tgz",
        "repo",
      ]);
    });

    it("does not publish anything if no charts found", async () => {
      jest.mocked(readdir).mockResolvedValueOnce([]);

      await helm.publishCharts("path", "repo", true);

      expect(exec).not.toBeCalled();
    });
  });

  describe("prepCharts", () => {
    beforeEach(() => {
      jest.spyOn(helm, "inlineReplace").mockImplementation(jest.fn());
      jest
        .spyOn(helm, "findMatchingChartFiles")
        .mockResolvedValue(["dummyfile"]);
      jest.spyOn(helm, "prepChart").mockImplementation(jest.fn());
      jest.spyOn(helm, "getChartDirs").mockResolvedValue(["test1", "test2"]);
    });

    it("works", async () => {
      await helm.prepCharts("1234", "src", "dest");

      expect(helm.inlineReplace).toHaveBeenCalledTimes(2);
      expect(helm.prepChart).toHaveBeenCalledWith(
        "dest/test1",
        "dest",
        "1234",
        {
          recursive: true,
          replaceFileWithRepository: true,
          replaceVersionToken: true,
        }
      );
      expect(helm.prepChart).toHaveBeenCalledWith(
        "dest/test2",
        "dest",
        "1234",
        {
          recursive: true,
          replaceFileWithRepository: true,
          replaceVersionToken: true,
        }
      );

      expect(rm).toBeCalledWith("dest", { force: true, recursive: true });
      expect(rm).toBeCalledWith("dest/test1", { force: true, recursive: true });
      expect(rm).toBeCalledWith("dest/test2", { force: true, recursive: true });

      expect(mkdir).toBeCalledWith("dest", { recursive: true });
      expect(cp).toBeCalledWith("src", "dest", { recursive: true });
    });

    it("does not replace version when disabled", async () => {
      await helm.prepCharts("1234", "src", "dest", {
        replaceVersionToken: false,
      });

      expect(helm.inlineReplace).not.toBeCalled();
    });

    it("does not use helm docs when disabled", async () => {
      helm.options.useHelmDocs = false;
      await helm.prepCharts("1234", "src", "dest", {});
      expect(exec).not.toBeCalled();
    });

    it("uses helm docs when enabled", async () => {
      helm.options.useHelmDocs = true;
      await helm.prepCharts("1234", "src", "dest");
      expect(exec).toBeCalledWith("helm-docs", [
        "-u",
        "publish",
        "-s",
        "alphanum",
      ]);
    });

    it("replaces correct version", async () => {
      const replacerFn = jest.fn();
      jest
        .spyOn(helm, "inlineReplace")
        .mockImplementation(async (path, replacers) => {
          replacerFn(
            replacers(
              `${helm.options.versionToken.toLowerCase()}\ntest\n${helm.options.versionToken.toUpperCase()}`
            )
          );
        });
      await helm.prepCharts("1234", "src", "dest");
      expect(replacerFn).toBeCalledTimes(2);
      expect(replacerFn).toBeCalledWith(`1234\ntest\n1234`);
      expect(replacerFn).toBeCalledWith(`1234\ntest\n1234`);
      //expect(helm.inlineReplace).toBeCalledWith(8)
    });
  });
});
