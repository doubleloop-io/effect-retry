import { afterAll, beforeAll, describe, expect, test } from "vitest"
import mockttp from "mockttp"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import * as Http from "@effect/platform/HttpClient"
import * as Schema from "@effect/schema/Schema"
import * as F from "effect/Function"
import * as Schedule from "effect/Schedule"
import * as TestContext from "effect/TestContext"
import * as TestClock from "effect/TestClock"

const mockServer = mockttp.getLocal()

beforeAll(() => mockServer.start(8080))
afterAll(() => mockServer.stop())

test("HTTP 200", async () => {
    await replyOk("http200", "Hello, world!")

    const result = await F.pipe(helloWorld("http200"), run)

    expect(result).toEqual("Hello, world!")
})

test.skip("retry once", async () => {
    await replyError("once", 500)
    await replyOk("once", "Hello, world!")

    const result = await F.pipe(
        helloWorld("once"),
        // TODO - add implementation here
        run,
    )

    expect(result).toEqual("Hello, world!")
})

test.skip("retry forever", async () => {
    await replyError("forever", 500)
    await replyError("forever", 500)
    await replyOk("forever", "Hello, world!")

    const result = await F.pipe(
        helloWorld("forever"),
        // TODO - add implementation here
        run,
    )

    expect(result).toEqual("Hello, world!")
})

test.skip("too much errors", async () => {
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyOk("too-much", "Hello, world!") // Too late

    const result = await F.pipe(
        helloWorld("too-much"),
        // TODO - add implementation here
        runExit,
    )

    expectFailureWithStatusCode(result, 500)
})

describe.skip("fatal errors", () => {
    test("fatal", async () => {
        await replyError("fatal", 404)
        await replyOk("fatal", "Hello, world!")

        const result = await F.pipe(
            helloWorld("fatal"),
            // TODO - add implementation here
            runExit,
        )

        expectFailureWithStatusCode(result, 404)
    })

    test("not fatal", async () => {
        await replyError("not-fatal", 500)
        await replyOk("not-fatal", "Hello, world!")

        const result = await F.pipe(
            helloWorld("not-fatal"),
            // TODO - add implementation here (same implementation as in the previous test)
            runExit,
        )

        expect(result).toEqual("Hello, world!")
    })
})

test.skip("exponential backoff", async () => {
    await replyError("backoff", 500)
    await replyError("backoff", 500)
    await replyError("backoff", 500)
    await replyOk("backoff", "Hello, world!")

    const result = await Effect.gen(function* (_) {
        const ret = yield* _(
            helloWorld("backoff"),
            // TODO - add implementation here
            Effect.fork,
        )

        yield* _(TestClock.adjust("100 millis"))
        yield* _(TestClock.adjust("200 millis"))
        yield* _(TestClock.adjust("400 millis"))

        return yield* _(Effect.fromFiber(ret))
    }).pipe(run)

    expect(result).toEqual("Hello, world!")
})

test.skip("fixed", async () => {
    await replyError("fixed", 500)
    await replyError("fixed", 500)
    await replyOk("fixed", "Hello, world!")

    const result = await Effect.gen(function* (_) {
        const ret = yield* _(
            helloWorld("fixed"),
            // TODO - add implementation here
            Effect.fork,
        )

        yield* _(TestClock.adjust("100 millis"))
        yield* _(TestClock.adjust("100 millis"))

        return yield* _(Effect.fromFiber(ret))
    }).pipe(run)

    expect(result).toEqual("Hello, world!")
})

test.skip("timeout", async () => {
    await replyError("timeout", 500)
    await replyError("timeout", 500)
    await replyError("timeout", 500)
    await replyOk("timeout", "Hello, world!") // This won't be reached

    const result = await Effect.gen(function* (_) {
        const ret = yield* _(
            helloWorld("timeout"),
            Effect.retry(Schedule.exponential("100 millis", 2)),
            // TODO - add implementation here
            Effect.fork,
        )

        yield* _(TestClock.adjust("100 millis"))
        yield* _(TestClock.adjust("200 millis"))
        yield* _(TestClock.adjust("200 millis")) // Timeout

        return yield* _(Effect.fromFiber(ret))
    }).pipe(runExit)

    expectIsFailure(result)
    expectIsFail(result.cause)
    expect(result.cause.error).toBeInstanceOf(Cause.TimeoutException)
})

describe("fixed vs spaced", () => {
    const _200msTask = Effect.sleep("200 millis")
    const adjustClockForTask = TestClock.adjust("200 millis")

    test("job duration reduce repetition intervals", async () => {
        await Effect.gen(function* (_) {
            const ret = yield* _(
                _200msTask,
                Effect.repeat(Schedule.intersect(Schedule.fixed("100 millis"), Schedule.recurs(3))),
                Effect.fork,
            )

            yield* _(adjustClockForTask)
            yield* _(TestClock.adjust("35 millis")) // awake Effect (?)
            yield* _(adjustClockForTask)
            yield* _(TestClock.adjust("35 millis")) // awake Effect (?)
            yield* _(adjustClockForTask)
            yield* _(TestClock.adjust("35 millis")) // awake Effect (?)
            yield* _(adjustClockForTask)

            yield* _(Effect.fromFiber(ret))
        }).pipe(run)
    })

    test("job duration doesn't reduce repetition intervals", async () => {
        const adjustClockForSpacedInterval = TestClock.adjust("100 millis")

        await Effect.gen(function* (_) {
            const ret = yield* _(
                _200msTask,
                Effect.repeat(Schedule.intersect(Schedule.spaced("100 millis"), Schedule.recurs(3))),
                Effect.fork,
            )

            yield* _(adjustClockForTask)
            yield* _(adjustClockForSpacedInterval)
            yield* _(adjustClockForTask)
            yield* _(adjustClockForSpacedInterval)
            yield* _(adjustClockForTask)
            yield* _(adjustClockForSpacedInterval)
            yield* _(adjustClockForTask)

            yield* _(Effect.fromFiber(ret))
        }).pipe(run)
    })
})

const provideLayers = <A, E>(effect: Effect.Effect<A, E, Http.client.Client.Default>) =>
    F.pipe(effect, Effect.provide(Http.client.layer), Effect.provide(TestContext.TestContext))

const run = F.flow(provideLayers, Effect.runPromise)
const runExit = F.flow(provideLayers, Effect.runPromiseExit)

const helloWorld = (prefix: string) =>
    Effect.gen(function* (_) {
        const defaultClient = yield* _(Http.client.Client)
        const client = defaultClient.pipe(Http.client.filterStatusOk)

        return yield* _(
            client(Http.request.get(`http://localhost:8080/${prefix}/hello-world`)),
            Http.response.schemaBodyJsonEffect(Schema.string),
        )
    })

const replyOk = (prefix: string, body: string) =>
    mockServer.forGet(`/${prefix}/hello-world`).thenReply(200, JSON.stringify(body))

const replyError = (prefix: string, status: number) => mockServer.forGet(`/${prefix}/hello-world`).thenReply(status)

function expectIsFailure<A, E>(exit: Exit.Exit<A, E>): asserts exit is Exit.Failure<A, E> {
    expect(Exit.isFailure(exit), "Expected to be Failure, but it was Success").toBeTruthy()
}

function expectIsFail<E>(cause: Cause.Cause<E>): asserts cause is Cause.Fail<E> {
    expect(Cause.isFailType(cause), `Expected to be Fail, but it was ${cause._tag}`).toBeTruthy()
}

const expectFailWithStatusCode = <E>(fail: Cause.Fail<E>, status: number) =>
    expect(fail.error).toMatchObject({ reason: "StatusCode", response: { status } })

const expectFailureWithStatusCode = <E>(exit: Exit.Exit<unknown, E>, status: number) => {
    expectIsFailure(exit)
    expectIsFail(exit.cause)
    expectFailWithStatusCode(exit.cause, status)
}
