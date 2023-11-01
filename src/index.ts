import {
  Auto,
  IPlugin,
  DEFAULT_PRERELEASE_BRANCHES,
  execPromise,
  getCurrentBranch,
  determineNextVersion,
  validatePluginConfiguration,
} from '@auto-it/core'
import { inc, ReleaseType } from 'semver'
import * as t from 'io-ts'
import { Helm } from './helm'

const pluginOptions = t.partial({
  /** Path to use for charts */
  path: t.string,
  /** Look for all charts in path */
  recursive: t.boolean,
  /** Push */
  push: t.boolean,
  /** Force push versions */
  forcePush: t.boolean,
  /** Enable canary deployments */
  enableCanary: t.boolean,
  /** Enable prerelease deployments */
  enablePreleases: t.boolean,
  /** Replace version string */
  replaceVersionString: t.boolean,
  /** Replace file references with repository */
  replaceFileWithRepository: t.boolean,
  /** Repository to use */
  repository: t.string,
  /** Version string to use */
  versionString: t.string,
  /** Use helm docs */
  useHelmDocs: t.boolean,
  /** Publish path to use */
  publishPath: t.string,
  /** Repository to publish to */
  publishRepository: t.string,
})

enum HELM_PLUGIN_ENV_VARS {
  PATH = 'HELM_PLUGIN_PATH',
  RECURSIVE = 'HELM_PLUGIN_RECURSIVE',
  FORCE_PUSH = 'HELM_PLUGIN_FORCE_PUSH',
  PUSH = 'HELM_PLUGIN_PUSH',
  ENABLE_CANARY = 'HELM_PLUGIN_ENABLE_CANARY',
  ENABLE_PRERELEASES = 'HELM_PLUGIN_ENABLE_PRERELEASE',
  REPLACE_VERSION_STRING = 'HELM_PLUGIN_REPLACE_VERSION_STRING',
  REPLACE_FILE_WITH_REPOSITORY = 'HELM_PLUGIN_REPLACE_FILE_WITH_REPOSITORY',
  REPOSITORY = 'HELM_PLUGIN_REPOSITORY',
  VERSION_STRING = 'HELM_PLUGIN_VERSION_STRING',
  USE_HELM_DOCS = 'HELM_PLUGIN_USE_HELM_DOCS',
  PUBLISH_PATH = 'HELM_PLUGIN_PUBLISH_PATH',
  PUBLISH_REPOSITORY = 'HELM_PLUGIN_PUBLISH_REPOSITORY',
}

function toBoolean(v?: string | number | boolean) {
  return String(v).search(/(true|1)/i) >= 0
}

export type IHelmPluginOptions = t.TypeOf<typeof pluginOptions>

export default class HelmPlugin implements IPlugin {
  /** The name of the plugin */
  name = 'helm'

  private readonly options: Required<IHelmPluginOptions>

  constructor(options: IHelmPluginOptions) {
    this.options = {
      path: process.env[HELM_PLUGIN_ENV_VARS.PATH] || options?.path || '.',
      enableCanary: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.ENABLE_CANARY] ||
          options?.enableCanary ||
          false,
      ),
      enablePreleases: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.ENABLE_PRERELEASES] ||
          options?.enablePreleases ||
          false,
      ),
      push: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.PUSH] || options?.push || false,
      ),
      forcePush: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.FORCE_PUSH] ||
          options?.forcePush ||
          false,
      ),
      recursive: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.RECURSIVE] ||
          options?.recursive ||
          false,
      ),
      replaceFileWithRepository: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.REPLACE_FILE_WITH_REPOSITORY] ||
          options?.replaceFileWithRepository ||
          false,
      ),
      replaceVersionString: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.REPLACE_VERSION_STRING] ||
          options?.replaceVersionString ||
          true,
      ),
      repository:
        process.env[HELM_PLUGIN_ENV_VARS.REPOSITORY] ||
        options?.repository ||
        '',
      versionString:
        process.env[HELM_PLUGIN_ENV_VARS.VERSION_STRING] ||
        options?.versionString ||
        '0.0.0-local',
      useHelmDocs: toBoolean(
        process.env[HELM_PLUGIN_ENV_VARS.USE_HELM_DOCS] ||
          options?.useHelmDocs ||
          false,
      ),
      publishPath:
        process.env[HELM_PLUGIN_ENV_VARS.PUBLISH_PATH] ||
        options.publishPath ||
        'publish',
      publishRepository:
        process.env[HELM_PLUGIN_ENV_VARS.PUBLISH_REPOSITORY] ||
        options.publishRepository ||
        '',
    }
  }

  apply(auto: Auto) {
    const helm = new Helm(auto.logger, {
      useHelmDocs: this.options.useHelmDocs,
      versionToken: this.options.versionString,
    })

    async function getTag() {
      if (!auto.git) return auto.prefixRelease('0.0.0')

      try {
        return await auto.git.getLatestTagInBranch()
      } catch (error) {
        return auto.prefixRelease('0.0.0')
      }
    }

    auto.hooks.beforeRun.tapPromise(this.name, async () => {
      await helm.validateDependencies()
    })

    auto.hooks.getPreviousVersion.tapPromise(this.name, async () => {
      if (!auto.git) {
        throw new Error(
          "Can't calculate previous version without Git initialized!",
        )
      }

      return getTag()
    })

    auto.hooks.validateConfig.tapPromise(this.name, async (name, options) => {
      if (name === this.name || name === `@auto-it/${this.name}`) {
        return validatePluginConfiguration(this.name, pluginOptions, options)
      }
    })

    auto.hooks.canary.tapPromise(
      this.name,
      async ({ bump, canaryIdentifier, dryRun }) => {
        if (!auto.git) return

        if (!this.options.enableCanary) {
          auto.logger.log.info(`Canary releases are not enabled. Skipping.`)
          return
        }

        const lastRelease = await auto.git.getLatestRelease()
        const current = await auto.getCurrentVersion(lastRelease)
        const nextVersion = inc(current, bump as ReleaseType)

        if (!nextVersion) {
          auto.logger.log.info('Cannot determine version')
          return
        }

        const canaryVersion = `${nextVersion}-${canaryIdentifier}`

        if (dryRun) {
          auto.logger.log.info(
            `[DRY RUN] Would have created canary version: ${canaryVersion}`,
          )
          return
        }

        auto.logger.log.info(`Creating canary version: ${canaryVersion}`)
        await helm.prepCharts(
          canaryVersion,
          this.options.path,
          this.options.publishPath,
          {
            recursive: this.options.recursive,
            replaceFileWithRepository: this.options.replaceFileWithRepository,
            replaceVersionToken: this.options.replaceVersionString,
            repository: this.options.repository,
          },
        )

        if (this.options.push) {
          await helm.publishCharts(
            this.options.publishPath,
            this.options.publishRepository,
            this.options.forcePush,
          )

          //await execPromise("git", ["tag", "-f", `${canaryAliasVersion}`, "-m", `Tag pull request canary: ${canaryAliasVersion} (${canaryVersion})`]);
          //await execPromise("git", ["push", auto.remote, `refs/tags/${canaryAliasVersion}`, "-f"]);
        }
      },
    )

    auto.hooks.publish.tapPromise(this.name, async (args) => {
      if (!auto.git) return

      const lastTag = await getTag()
      const newTag = inc(lastTag, args.bump as ReleaseType)

      if (!newTag) {
        auto.logger.log.info('No release found, doing nothing')
        return
      }

      const prefixedTag = auto.prefixRelease(newTag)

      await helm.prepCharts(
        prefixedTag,
        this.options.path,
        this.options.publishPath,
        {
          recursive: this.options.recursive,
          replaceFileWithRepository: this.options.replaceFileWithRepository,
          replaceVersionToken: this.options.replaceVersionString,
          repository: this.options.repository,
        },
      )
      if (this.options.push) {
        await helm.publishCharts(
          this.options.publishPath,
          this.options.publishRepository,
          this.options.forcePush,
        )

        await execPromise('git', [
          'tag',
          prefixedTag,
          '-m',
          `"Update version to ${prefixedTag}"`,
        ])
        await execPromise('git', [
          'push',
          '--follow-tags',
          '--set-upstream',
          auto.remote,
          getCurrentBranch() || auto.baseBranch,
        ])
      }
    })

    auto.hooks.version.tapPromise(this.name, async (args) => {
      if (!auto.git) return

      const lastTag = await getTag()
      const newTag = inc(lastTag, args.bump as ReleaseType)

      if (!newTag) {
        auto.logger.log.info('No release found, doing nothing')
        return
      }

      const prefixedTag = auto.prefixRelease(newTag)

      auto.logger.log.warn(`DOING VERSION: ${prefixedTag}`)
    })

    auto.hooks.next.tapPromise(this.name, async (prereleaseVersions, args) => {
      if (!auto.git) return prereleaseVersions

      if (!this.options.enablePreleases) return prereleaseVersions

      const prereleaseBranches =
        auto.config?.prereleaseBranches ?? DEFAULT_PRERELEASE_BRANCHES
      const branch = getCurrentBranch() || ''
      const prereleaseBranch = prereleaseBranches.includes(branch)
        ? branch
        : prereleaseBranches[0]
      const lastRelease = await auto.git.getLatestRelease()
      const current =
        (await auto.git.getLastTagNotInBaseBranch(prereleaseBranch)) ||
        (await auto.getCurrentVersion(lastRelease))
      const prerelease = auto.prefixRelease(
        determineNextVersion(lastRelease, current, args.bump, prereleaseBranch),
      )

      prereleaseVersions.push(prerelease)

      await helm.prepCharts(
        prerelease,
        this.options.path,
        this.options.publishPath,
        {
          recursive: this.options.recursive,
          replaceFileWithRepository: this.options.replaceFileWithRepository,
          replaceVersionToken: this.options.replaceVersionString,
          repository: this.options.repository,
        },
      )

      if (this.options.push) {
        await helm.publishCharts(
          this.options.publishPath,
          this.options.publishRepository,
          this.options.forcePush,
        )

        await execPromise('git', [
          'tag',
          prerelease,
          '-m',
          `"Tag pre-release: ${prerelease}"`,
        ])
        await execPromise('git', ['push', auto.remote, branch, '--tags'])
      }
      return prereleaseVersions
    })
  }
}
