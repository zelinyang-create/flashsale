const { createHash } = require("crypto")
const { execFileSync, spawnSync } = require("child_process")
const {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} = require("fs")
const os = require("os")
const path = require("path")

const pluginRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(pluginRoot, "../../..")
const defaultTarget = path.join(
  pluginRoot,
  "artifacts",
  "phase1",
  "phase1-correctness-gate.json"
)
const targetPath = path.resolve(
  process.env.FLASH_SALE_PHASE1_REPORT_PATH || defaultTarget
)
const candidatePath = `${targetPath}.candidate`
const jestBin = path.join(repoRoot, "node_modules", "jest", "bin", "jest.js")
const yarnBin = path.join(repoRoot, ".yarn", "releases", "yarn-3.2.1.cjs")
const lockfilePath = path.join(repoRoot, "yarn.lock")

function removeArtifacts() {
  rmSync(candidatePath, { force: true })
  rmSync(targetPath, { force: true })
}

function gitOutput(args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch (error) {
    if (allowFailure) return null
    throw error
  }
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/")
}

function captureSourceMetadata() {
  const excluded = new Set([
    repoRelative(targetPath),
    repoRelative(candidatePath),
  ])
  const readPaths = (args) => {
    const output = gitOutput(args)
    return output
      ? output
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((entry) => entry.replaceAll("\\", "/"))
          .filter((entry) => !excluded.has(entry))
      : []
  }

  try {
    const head = gitOutput(["rev-parse", "HEAD"])
    const branch = gitOutput(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      true
    )
    const tracked = readPaths(["diff", "--name-only"])
    const staged = readPaths(["diff", "--cached", "--name-only"])
    const untracked = readPaths(["ls-files", "--others", "--exclude-standard"])
    return {
      metadata_available: true,
      branch,
      head,
      dirty: tracked.length + staged.length + untracked.length > 0,
      changes: { tracked, staged, untracked },
    }
  } catch (error) {
    return {
      metadata_available: false,
      branch: null,
      head: null,
      dirty: true,
      changes: { tracked: [], staged: [], untracked: [] },
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function yarnVersion() {
  const result = spawnSync(process.execPath, [yarnBin, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function runtimeMetadata() {
  const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model))]
  return {
    node: process.version,
    yarn: yarnVersion(),
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    cpu: {
      logical_count: os.cpus().length,
      models: cpuModels,
    },
    memory: {
      total_bytes: os.totalmem(),
      free_bytes_at_start: os.freemem(),
    },
    lockfile: {
      path: repoRelative(lockfilePath),
      sha256: sha256File(lockfilePath),
    },
  }
}

function ciMetadata() {
  if (!process.env.GITHUB_ACTIONS) return null
  const serverUrl = process.env.GITHUB_SERVER_URL
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  return {
    provider: "github-actions",
    event_name: process.env.GITHUB_EVENT_NAME || null,
    ref: process.env.GITHUB_REF || null,
    sha: process.env.GITHUB_SHA || null,
    run_id: runId || null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    run_url:
      serverUrl && repository && runId
        ? `${serverUrl}/${repository}/actions/runs/${runId}`
        : null,
  }
}

function isPlainRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
}

function exactZeroFields(record, fields) {
  return (
    isPlainRecord(record) &&
    Object.keys(record).length === fields.length &&
    fields.every((field) => record[field] === 0)
  )
}

function validRound(round, expectedRound) {
  if (
    !round ||
    round.round !== expectedRound ||
    !round.quota ||
    !round.same_key ||
    !round.reconciliations
  ) {
    return false
  }
  const quota = round.quota
  const sameKey = round.same_key
  const invariantFields = [
    "bad_capacity",
    "bad_subject",
    "capacity_held_mismatch",
    "capacity_consumed_mismatch",
    "subject_held_mismatch",
    "subject_consumed_mismatch",
  ]
  const reconciliationKeys = [
    "quota",
    "same_key",
    "subject_limit",
    "settlement",
    "different_request",
    "multi_item",
    "reverse_order",
    "consume_replay",
    "release_replay",
    "expiry_workers",
  ]
  return (
    quota.held === 50 &&
    quota.rejected === 450 &&
    quota.unexpected === 0 &&
    quota.replayed === 0 &&
    quota.database &&
    quota.database.attempts === 500 &&
    quota.database.holds === 50 &&
    quota.database.held_attempts === 50 &&
    quota.database.rejected_attempts === 450 &&
    quota.database.capacity_held === 50 &&
    quota.database.capacity_consumed === 0 &&
    quota.database.distinct_business_identities === 500 &&
    quota.database.duplicate_business_identities === 0 &&
    exactZeroFields(quota.invariants, invariantFields) &&
    quota.reconciliation &&
    quota.reconciliation.issue_count === 0 &&
    sameKey.held === 20 &&
    sameKey.rejected === 0 &&
    sameKey.unexpected === 0 &&
    sameKey.replayed === 19 &&
    sameKey.database &&
    sameKey.database.attempts === 1 &&
    sameKey.database.holds === 1 &&
    sameKey.database.held_attempts === 1 &&
    sameKey.database.rejected_attempts === 0 &&
    sameKey.database.capacity_held === 1 &&
    sameKey.database.capacity_consumed === 0 &&
    sameKey.database.distinct_business_identities === 1 &&
    sameKey.database.duplicate_business_identities === 0 &&
    exactZeroFields(sameKey.invariants, invariantFields) &&
    sameKey.reconciliation &&
    sameKey.reconciliation.issue_count === 0 &&
    isPlainRecord(round.reconciliations) &&
    Object.keys(round.reconciliations).length === reconciliationKeys.length &&
    reconciliationKeys.every((key) => {
      const reconciliation = round.reconciliations[key]
      return (
        reconciliation &&
        reconciliation.healthy === true &&
        reconciliation.skipped === false &&
        reconciliation.issue_count === 0
      )
    })
  )
}

function validAllocationCandidate(candidate) {
  if (
    !candidate ||
    candidate.schema !== "flash-sale.phase1-allocation-candidate.v1" ||
    candidate.gate !== "allocation" ||
    candidate.passed !== true ||
    !candidate.configuration ||
    candidate.configuration.mode !== "full" ||
    candidate.configuration.workers !== 4 ||
    candidate.configuration.rounds !== 10 ||
    candidate.configuration.quota !== 50 ||
    candidate.configuration.concurrency !== 500 ||
    candidate.configuration.submitted_attempts_per_round !== 500 ||
    candidate.configuration.db_pool_max_per_worker !== 8 ||
    candidate.configuration.transport !== "child_process_stdio" ||
    candidate.configuration.invocation !== "direct_handler" ||
    candidate.configuration.timing_not_for_throughput !== true ||
    !Array.isArray(candidate.rounds) ||
    candidate.rounds.length !== 10 ||
    !candidate.summary ||
    candidate.summary.passed !== true ||
    candidate.summary.completed_rounds !== 10 ||
    candidate.summary.quota_total_held !== 500 ||
    candidate.summary.quota_total_rejected !== 4500 ||
    candidate.summary.quota_total_unexpected !== 0 ||
    candidate.summary.duplicate_business_identities !== 0 ||
    candidate.summary.reconciliation_issue_count !== 0
  ) {
    return false
  }
  return candidate.rounds.every((round, index) =>
    validRound(round, index + 1)
  )
}

function run(label, command, args, env = process.env) {
  process.stdout.write(`\n[phase1-gate] ${label}\n`)
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    env,
    stdio: "inherit",
  })
  if (result.error) {
    process.stderr.write(`[phase1-gate] ${label}: ${result.error.message}\n`)
    return 1
  }
  return result.status === null ? 1 : result.status
}

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  )
  mkdirSync(directory, { recursive: true })
  let descriptor
  try {
    descriptor = openSync(temporaryPath, "wx")
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporaryPath, { force: true })
  }
}

function fail(message) {
  removeArtifacts()
  process.stderr.write(`\n[phase1-gate] FAILED: ${message}\n`)
  process.exitCode = 1
}

function main() {
  removeArtifacts()
  const source = captureSourceMetadata()
  const runtime = runtimeMetadata()
  const startedAt = Date.now()
  const allocationExit = run(
    "allocation multiprocess correctness suite",
    process.execPath,
    [
      jestBin,
      "--runInBand",
      "--forceExit",
      "--runTestsByPath",
      "src/modules/flash-sale-allocation/integration-tests/multiprocess-allocation.spec.ts",
      "--modulePathIgnorePatterns=\\.medusa/",
    ],
    Object.assign({}, process.env, {
      FLASH_SALE_MULTIPROCESS_FULL: "1",
      FLASH_SALE_PHASE1_CANDIDATE_PATH: candidatePath,
    })
  )
  if (allocationExit !== 0) {
    fail(`allocation suite exited with ${allocationExit}`)
    return
  }
  if (!existsSync(candidatePath)) {
    fail("allocation suite passed without producing its candidate evidence")
    return
  }

  const buildExit = run("checkout full-app build", process.execPath, [
    yarnBin,
    "run",
    "build:plugin",
  ])
  if (buildExit !== 0) {
    fail(`checkout full-app build exited with ${buildExit}`)
    return
  }
  const checkoutExit = run(
    "checkout full-app regression suite",
    process.execPath,
    [
      jestBin,
      "--runInBand",
      "--forceExit",
      "--runTestsByPath",
      "full-app-tests/flash-sale-checkout.full-app.spec.ts",
      "--modulePathIgnorePatterns=\\.medusa/",
    ]
  )
  if (checkoutExit !== 0) {
    fail(`checkout full-app suite exited with ${checkoutExit}`)
    return
  }

  let allocationGate
  try {
    allocationGate = JSON.parse(readFileSync(candidatePath, "utf8"))
  } catch (error) {
    fail(
      `allocation candidate is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return
  }
  if (!validAllocationCandidate(allocationGate)) {
    fail(
      "allocation candidate does not satisfy the complete Phase 1 exit contract"
    )
    return
  }

  const releaseEligible = source.metadata_available && !source.dirty
  if (
    process.env.GITHUB_ACTIONS &&
    (!releaseEligible || source.head !== process.env.GITHUB_SHA)
  ) {
    fail(
      "GitHub Actions source state is dirty, unavailable, or does not match GITHUB_SHA"
    )
    return
  }
  const report = {
    schema: "flash-sale.phase1-correctness-gate.v1",
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    passed: true,
    source,
    runtime,
    ci: ciMetadata(),
    release_evidence: {
      eligible: releaseEligible,
      reason: releaseEligible
        ? null
        : "Source metadata is unavailable or the working tree was dirty when the gate started.",
    },
    allocation_gate: allocationGate,
    checkout_full_app: {
      passed: true,
      suite: "full-app-tests/flash-sale-checkout.full-app.spec.ts",
      evidence: {
        source: "existing full-app assertions",
        response_loss_replay: "one Order, one Reservation, one PurchaseAttempt",
        different_key_same_cart_race: "one Order and one Reservation",
      },
      boundary:
        "This proves checkout replay/race correctness in the full-app suite; it is not a 500-request HTTP order benchmark.",
    },
    summary: {
      passed: true,
      allocation_gate_passed: true,
      checkout_full_app_passed: true,
      quota_total_held: allocationGate.summary.quota_total_held,
      quota_total_rejected: allocationGate.summary.quota_total_rejected,
      quota_total_unexpected: allocationGate.summary.quota_total_unexpected,
      duplicate_business_identities:
        allocationGate.summary.duplicate_business_identities,
      reconciliation_issue_count:
        allocationGate.summary.reconciliation_issue_count,
    },
  }

  try {
    writeJsonAtomically(targetPath, report)
    rmSync(candidatePath, { force: true })
    process.stdout.write(`\n[phase1-gate] PASSED: ${targetPath}\n`)
    if (!releaseEligible) {
      process.stdout.write(
        "[phase1-gate] Tests passed, but this report is not release evidence because the source state was not clean.\n"
      )
    }
  } catch (error) {
    fail(
      `could not publish the final report: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

main()
