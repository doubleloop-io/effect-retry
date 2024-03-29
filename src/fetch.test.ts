import { afterAll, beforeAll, describe, expect, test } from "vitest"
import mockttp from "mockttp"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import * as Http from "@effect/platform/HttpClient"
import * as Schema from "@effect/schema/Schema"
import * as ParseResult from "@effect/schema/ParseResult"
import * as F from "effect/Function"
import * as Schedule from "effect/Schedule"
import * as Match from "effect/Match"
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

test("retry once", async () => {
    await replyError("once", 500)
    await replyOk("once", "Hello, world!")

    const result = await F.pipe(helloWorld("once"), Effect.retry(Schedule.once), run)

    expect(result).toEqual("Hello, world!")
})

test("retry forever", async () => {
    await replyError("forever", 500)
    await replyError("forever", 500)
    await replyOk("forever", "Hello, world!")

    const result = await F.pipe(helloWorld("forever"), Effect.retry(Schedule.forever), run)

    expect(result).toEqual("Hello, world!")
})

test("too much errors", async () => {
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyError("too-much", 500)
    await replyOk("too-much", "Hello, world!") // Too late

    const result = await F.pipe(helloWorld("too-much"), Effect.retry(Schedule.recurs(3)), runExit)

    expectFailureWithStatusCode(result, 500)
})

describe("fatal errors", () => {
    const unrecoverableErrors = F.pipe(
        Match.type<Http.error.HttpClientError | ParseResult.ParseError>(),
        Match.tag("ResponseError", (x) => x.response.status === 404),
        Match.orElse(() => false),
    )
    const request = F.pipe(
        helloWorld("fatal"),
        Effect.retry({ schedule: Schedule.recurs(3), until: unrecoverableErrors }),
    )

    test("fatal", async () => {
        await replyError("fatal", 404)
        await replyOk("fatal", "Hello, world!")

        const result = await F.pipe(request, runExit)

        expectFailureWithStatusCode(result, 404)
    })

    test("not fatal", async () => {
        await replyError("fatal", 500)
        await replyOk("fatal", "Hello, world!")

        const result = await F.pipe(request, run)

        expect(result).toEqual("Hello, world!")
    })
})

test("exponential backoff", async () => {
    await replyError("backoff", 500)
    await replyError("backoff", 500)
    await replyError("backoff", 500)
    await replyOk("backoff", "Hello, world!")

    const result = await Effect.gen(function* (_) {
        const ret = yield* _(
            //keep new line
            helloWorld("backoff"),
            Effect.retry(Schedule.exponential("100 millis", 2)),
            Effect.fork,
        )

        yield* _(TestClock.adjust("100 millis"))
        yield* _(TestClock.adjust("200 millis"))
        yield* _(TestClock.adjust("400 millis"))

        return yield* _(Effect.fromFiber(ret))
    }).pipe(run)

    expect(result).toEqual("Hello, world!")
})

test("fixed", async () => {
    await replyError("fixed", 500)
    await replyError("fixed", 500)
    await replyOk("fixed", "Hello, world!")

    const result = await Effect.gen(function* (_) {
        const ret = yield* _(
            //keep new line
            helloWorld("fixed"),
            Effect.retry(Schedule.fixed("100 millis")),
            Effect.fork,
        )

        yield* _(TestClock.adjust("100 millis"))
        yield* _(TestClock.adjust("100 millis"))

        return yield* _(Effect.fromFiber(ret))
    }).pipe(run)

    expect(result).toEqual("Hello, world!")
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
