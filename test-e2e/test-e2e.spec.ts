import { RestClient } from 'typed-rest-client'
import { spawn } from 'child_process'

const CHARTMUSEUM_BASE_URL =
  process.env.CHARTMUSEUM_BASE_URL || 'http://localhost:8080'

interface IChartVersion {
  name: string
  version: string
}

interface ICharts {
  [chartName: string]: IChartVersion[]
}

async function runCommand(command: string, args: string[]) {
  return new Promise((resolve, reject) => {
    const cmd = spawn(command, args)

    cmd.stdout.on('data', (data) => {
      console.log(`${data}`)
    })

    cmd.stderr.on('data', (data) => {
      console.error(`${data}`)
    })

    cmd.on('close', (code) => {
      console.log(`child process exited with code ${code}`)

      if (code == 0) {
        resolve(code)
        return
      }

      reject(code)
    })
  })
}

describe('e2e tests', () => {
  const client: RestClient = new RestClient(
    'jest',
    `${CHARTMUSEUM_BASE_URL}/api`,
  )

  async function clearChartmuseum() {
    // remove everything from chartmuseum
    const res = await client.get<ICharts>('charts')

    for (const [, versions] of Object.entries(res.result || {})) {
      for (const version of versions) {
        await client.del(`charts/${version.name}/${version.version}`)
      }
    }
  }

  /**
   * Before running any tests we need to clear chartmuseum
   * and then make sure our test run of auto shipit actually
   * runs without error
   */
  beforeAll(async () => {
    await clearChartmuseum()
    const charts = await client.get('charts')
    expect(charts.statusCode).toBe(200)
    expect(JSON.stringify(charts.result)).toBe('{}')

    const autoReturnCode = await runCommand('npx', [
      'auto',
      'canary',
      '--force',
    ])
    expect(autoReturnCode).toBe(0)
  }, 40000)

  it('has correct charts uploaded to chartmuseum', async () => {
    const res = await client.get('charts')

    expect(res.statusCode).toBe(200)
    expect(res.result).toMatchObject({
      common: [
        {
          name: 'common',
          version: expect.stringContaining('canary'),
        },
      ],
      'vault-paths': [
        {
          name: 'vault-paths',
          version: expect.stringContaining('canary'),
        },
      ],
    })
  })
})
