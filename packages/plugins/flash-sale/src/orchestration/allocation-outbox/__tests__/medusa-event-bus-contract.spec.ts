import fs from "fs"
import path from "path"

function source(relative: string) {
  return fs.readFileSync(
    path.resolve(__dirname, "../../../../../../..", relative),
    "utf8"
  )
}

describe("Medusa 2.21 EventBus acceptance source contract", () => {
  it("Redis filters on registered subscribers and awaits BullMQ addBulk", () => {
    const abstractEventBus = source("packages/core/utils/src/event-bus/index.ts")
    const redis = source(
      "packages/modules/event-bus-redis/src/services/event-bus-redis.ts"
    )
    expect(abstractEventBus).toContain("public get eventToSubscribersMap()")
    expect(abstractEventBus).toContain("return this.eventToSubscribersMap_")
    expect(abstractEventBus).toContain(
      "const newSubscriberDescriptor = { subscriber, id: subscriberId }"
    )
    expect(redis).toContain("const eventsWithSubscribers = eventsToEmit")
    expect(redis).toContain("this.eventToSubscribersMap.get(eventData.name)")
    expect(redis).toContain('this.eventToSubscribersMap.get("*")')
    expect(redis).toContain("promises.push(this.queue_.addBulk(emitData))")
    expect(redis).toContain("await promiseAll(promises)")
    expect(redis).toContain("connection: eventBusRedisConnection")
  })

  it("Local schedules subscriber delivery without awaiting it", () => {
    const local = source(
      "packages/modules/event-bus-local/src/services/event-bus-local.ts"
    )
    expect(local).toContain("delay(options_?.delay).then(async () =>")
    expect(local).toContain(
      "this.eventEmitter_.emit(eventData.name, publishedEventBody)"
    )
  })

  it("Medusa autoloads scheduled jobs only in worker/shared mode", () => {
    const loader = source("packages/medusa/src/loaders/index.ts")
    expect(loader).toContain(
      'configModule.projectConfig.workerMode === "worker" ||'
    )
    expect(loader).toContain(
      'configModule.projectConfig.workerMode === "shared"'
    )
    expect(loader).toContain("if (shouldLoadBackgroundProcessors(configModule))")
    expect(loader).toContain("await jobsLoader(plugins, container)")
  })
})
