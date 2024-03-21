import { afterEach, beforeEach, expect, test } from "vitest"
import mockttp from "mockttp"
import * as Effect from "effect/Effect"
import * as Http from "@effect/platform/HttpClient"
import * as Schema from "@effect/schema/Schema"
import * as F from "effect/Function"

const mockServer = mockttp.getLocal()

beforeEach(() => mockServer.start(8080))
afterEach(() => mockServer.stop())

test("HTTP 200", async () => {
    await mockServer.forGet("/hello-world").thenReply(200, JSON.stringify("Hello, world!"))

    const result = await F.pipe(helloWorld, run)

    expect(result).toEqual("Hello, world!")
})

const run = <A, E>(effect: Effect.Effect<A, E, Http.client.Client.Default>) =>
    F.pipe(effect, Effect.provide(Http.client.layer), Effect.runPromise)

const helloWorld = Effect.gen(function* (_) {
    const defaultClient = yield* _(Http.client.Client)
    const client = defaultClient.pipe(Http.client.filterStatusOk)

    return yield* _(
        client(Http.request.get("http://localhost:8080/hello-world")),
        Http.response.schemaBodyJsonEffect(Schema.string),
    )
})
