import { afterEach, beforeEach, describe, expect, test } from "vitest"
import mockttp from "mockttp"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import * as Http from "@effect/platform/HttpClient"
import * as Schema from "@effect/schema/Schema"
import * as F from "effect/Function"
import * as Schedule from "effect/Schedule"
import * as Match from "effect/Match"
import * as ParseResult from "@effect/schema/ParseResult"

const mockServer = mockttp.getLocal()

beforeEach(() => mockServer.start(8080))
afterEach(() => mockServer.stop())

test("HTTP 200", async () => {
    await replyOk("Hello, world!")

    const result = await F.pipe(helloWorld, run)

    expect(result).toEqual("Hello, world!")
})

test("retry once", async () => {
    await replyError(500)
    await replyOk("Hello, world!")

    const result = await F.pipe(helloWorld, Effect.retry(Schedule.once), run)

    expect(result).toEqual("Hello, world!")
})

test("retry forever", async () => {
    await replyError(500)
    await replyError(500)
    await replyOk("Hello, world!")

    const result = await F.pipe(helloWorld, Effect.retry(Schedule.forever), run)

    expect(result).toEqual("Hello, world!")
})

test("too much errors", async () => {
    await replyError(500)
    await replyError(500)
    await replyError(500)
    await replyOk("Hello, world!") // Too late

    const result = await F.pipe(helloWorld, Effect.retry(Schedule.recurs(3)), runExit)

    expectFailureWithStatusCode(result, 500)
})

describe("fatal errors", () => {
    const fatal = F.pipe(Match.type<Http.error.HttpClientError | ParseResult.ParseError>(),
        Match.tag("ResponseError", (x) => x.response.status === 404),
        Match.tag("ParseError", F.constTrue),
        Match.tag("RequestError", F.constFalse),
        Match.exhaustive,
    )

    const request = F.pipe(helloWorld, Effect.retry({
        schedule: Schedule.recurs(3),
        until: fatal,
    }))

    test("fatal", async () => {
        await replyError(404)
        await replyOk("Hello, world!")

        const result = await F.pipe(request, runExit)

        expectFailureWithStatusCode(result, 404)
    })

    test("non fatal", async () => {
        await replyError(500)
        await replyOk("Hello, world!")

        const result = await F.pipe(request, run)

        expect(result).toEqual("Hello, world!")
    })
})

test("exponential backoff", async () => {
    await replyError(500)
    await replyError(500)
    await replyError(500)
    await replyOk("Hello, world!") // Too late

    const result = await F.pipe(helloWorld, Effect.retry(F.pipe(
            Schedule.exponential("100 millis", 2),
            Schedule.mapEffect((out) => Effect.logInfo(`Retrying after ${out}`)))),
        run)

    expect(result).toEqual("Hello, world!")
})

const provideLayers = <A, E>(effect: Effect.Effect<A, E, Http.client.Client.Default>) =>
    F.pipe(effect, Effect.provide(Http.client.layer))

const run = F.flow(provideLayers, Effect.runPromise)
const runExit = F.flow(provideLayers, Effect.runPromiseExit)

const helloWorld = Effect.gen(function* (_) {
    const defaultClient = yield* _(Http.client.Client)
    const client = defaultClient.pipe(Http.client.filterStatusOk)

    return yield* _(
        client(Http.request.get("http://localhost:8080/hello-world")),
        Http.response.schemaBodyJsonEffect(Schema.string),
    )
})

const replyOk = (body: string) => mockServer.forGet("/hello-world").thenReply(200, JSON.stringify(body))
const replyError = (status: number) => mockServer.forGet("/hello-world").thenReply(status)

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
