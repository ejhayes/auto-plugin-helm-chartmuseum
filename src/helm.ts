import { readdir, rm, mkdir, cp, readFile, writeFile } from 'fs/promises'
import { execPromise, ILogger } from '@auto-it/core'
import { join } from 'path'

enum TOOLS {
  HELM = 'helm',
  HELM_DOCS = 'helm-docs',
}

interface HelmOptions {
  versionToken: string
  useHelmDocs: boolean
}

interface PrepOptions {
  repository?: string
  recursive: boolean
  replaceVersionToken: boolean
  replaceFileWithRepository: boolean
}

export class Helm {
  options: HelmOptions

  constructor(
    private readonly logger: ILogger,
    options: Partial<HelmOptions>,
  ) {
    this.options = {
      useHelmDocs:
        options.useHelmDocs !== undefined ? options.useHelmDocs : true,
      versionToken:
        options.versionToken !== undefined
          ? options.versionToken
          : '0.0.0-local',
    }
  }

  async validateDependencies() {
    this.logger.log.info('Checking for helm...')
    await execPromise(TOOLS.HELM, ['version'])

    if (this.options.useHelmDocs) {
      this.logger.log.info('Checking for helm-docs...')
      await execPromise(TOOLS.HELM_DOCS, ['--version'])
    } else {
      this.logger.log.info('Skipping check for helm-docs')
    }
  }

  async publishCharts(path: string, repository: string, forcePush = false) {
    const chartsToPublish = (
      await readdir(path, {
        withFileTypes: true,
      })
    )
      .filter((i) => i.isFile() && i.name.search(/\.tgz$/) >= 0)
      .map((i) => join(path, i.name))

    for (const chart of chartsToPublish) {
      this.logger.log.info(`Publishing ${chart}`)
      await execPromise(TOOLS.HELM, [
        'cm-push',
        ...(forcePush ? ['-f'] : []),
        chart,
        repository,
      ])
    }
  }

  async prepCharts(
    version: string,
    srcPath: string,
    destPath: string,
    _opts: Partial<PrepOptions> = {},
  ) {
    const opts: PrepOptions = {
      recursive: true,
      replaceFileWithRepository: true,
      replaceVersionToken: true,
      ..._opts,
    }

    await rm(destPath, { recursive: true, force: true })
    await mkdir(destPath, { recursive: true })
    /**
     * recursive in this case just means that we want to
     * copy the full contents of the srcPath over to the
     * destPath
     */
    await cp(srcPath, destPath, {
      recursive: true,
    })

    // get list of chartDirs from the publish directory
    const chartDirs = await this.getChartDirs(destPath, opts.recursive)

    // replace all versions with the current version
    for (const chartDir of chartDirs) {
      const chartPath = join(destPath, chartDir)
      if (opts.replaceVersionToken && this.options.versionToken) {
        this.logger.log.info(`Using: ${chartPath}`)
        const files = await this.findMatchingChartFiles(chartPath)
        this.logger.log.info(files)
        for (const file of files) {
          await this.inlineReplace(join(chartPath, file), (content) => {
            return content.replace(
              new RegExp(this.options.versionToken, 'ig'),
              version,
            )
          })
        }
      }
    }

    if (this.options.useHelmDocs) {
      this.logger.log.info('Updating documentation')
      await execPromise(TOOLS.HELM_DOCS, ['-u', 'publish', '-s', 'alphanum'])
    } else {
      this.logger.log.info('Skipping documentation generation')
    }

    for (const chartDir of chartDirs) {
      await this.prepChart(join(destPath, chartDir), destPath, version, opts)
    }

    for (const chartDir of chartDirs) {
      await rm(join(destPath, chartDir), {
        recursive: true,
        force: true,
      })
    }
  }

  async inlineReplace(path: string, replacers: (contents: string) => string) {
    this.logger.log.debug(`Inline replacement for ${path}`)

    const contents = replacers((await readFile(path)).toString())

    return await writeFile(path, contents)
  }

  async findMatchingChartFiles(chartPath: string) {
    const MATCHER = /(readme\.md)|(chart\.ya?ml)|(chart\.lock)/i
    return (await readdir(chartPath, { withFileTypes: true }))
      .filter((i) => i.isFile())
      .map((i) => i.name)
      .filter((i) => i.search(MATCHER) >= 0)
  }

  async prepChart(
    srcPath: string,
    destPath: string,
    version: string,
    opts: PrepOptions,
  ) {
    this.logger.log.info(`Creating chart: ${srcPath} version ${version}`)

    // remove charts dir external dependencies
    await rm(join(srcPath, 'charts', '*.tgz'), {
      recursive: true,
      force: true,
    })

    // update dependencies
    await execPromise(TOOLS.HELM, ['dep', 'up', srcPath])

    // update file references with repo aliases
    if (opts.replaceFileWithRepository && opts.repository) {
      for (const file of await this.findMatchingChartFiles(srcPath)) {
        await this.inlineReplace(join(srcPath, file), (contents) => {
          return contents.replace(/file:\/\/[^\s]+/g, `'${opts.repository}'`)
        })
      }
    }

    // package the chart
    await execPromise(TOOLS.HELM, ['package', srcPath, '-d', destPath])
  }

  async getChartDirs(path: string, recursive = false): Promise<string[]> {
    if (recursive) {
      return (
        /**
         * Behavior of readdir differs with recursive option set to true.
         * - On mac/ubuntu environments setting this value to true has the same
         *   behavior (1 level deep)
         *   $ mkdir -p test1/d0/d1
         *   $ node -e "const readdir = require('fs/promises').readdir; readdir('test1',{recursive: true}).then((res) => console.log(res))"
         *   [ 'd0' ]
         * 
         * - On github actions (using ubuntu-latest) setting this value to true
         *   returns all nested directories (more than 1 level deep)
         *   $ mkdir -p test1/d0/d1
         *   $ node -e "const readdir = require('fs/promises').readdir; readdir('test1',{recursive: true}).then((res) => console.log(res))"
         *   [ 'd0', 'd0/d1' ]
         * 
         * This could possibly be related to https://github.com/nodejs/node/issues/49243
         * but regardless should not be set to any other value than false until we can
         * guarantee behavior between environments
         */
        await readdir(path, {
          recursive: false,
          withFileTypes: true,
        })
      )
        .filter((i) => i.isDirectory())
        .map((i) => i.name)
    }

    return [path]
  }
}
